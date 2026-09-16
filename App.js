
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import RNBluetoothClassic from 'react-native-bluetooth-classic';

const POLL_MS = 1200;
const ELM_TIMEOUT_MS = 3500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanElmText(value) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .replace(/\r/g, '\n')
    .replace(/>/g, '\n')
    .replace(/[^\x20-\x7E\n]/g, '')
    .toUpperCase();
}

function bytesFromHex(text) {
  return text
    .replace(/[^0-9A-F]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => parseInt(x, 16));
}

function parsePid(response, pid) {
  const bytes = bytesFromHex(response);
  const idx = bytes.findIndex((v, i) => v === 0x40 + 0x01 && bytes[i + 1] === pid);
  if (idx < 0 || idx + 2 >= bytes.length) return null;
  return bytes.slice(idx + 2);
}

function parseRpm(response) {
  const b = parsePid(response, 0x0c);
  return b?.length >= 2 ? Math.round(((b[0] * 256) + b[1]) / 4) : null;
}

function parseCoolant(response) {
  const b = parsePid(response, 0x05);
  return b?.length >= 1 ? b[0] - 40 : null;
}

function parseLoad(response) {
  const b = parsePid(response, 0x04);
  return b?.length >= 1 ? Math.round((b[0] * 100) / 255) : null;
}

function parseSpeed(response) {
  const b = parsePid(response, 0x0d);
  return b?.length >= 1 ? b[0] : null;
}

function parseThrottle(response) {
  const b = parsePid(response, 0x11);
  return b?.length >= 1 ? Math.round((b[0] * 100) / 255) : null;
}

function parseVoltage(response) {
  const b = parsePid(response, 0x42);
  return b?.length >= 2 ? (((b[0] * 256) + b[1]) / 1000).toFixed(1) + 'V' : null;
}

function parseDtcResponse(response) {
  const bytes = bytesFromHex(response);
  const start = bytes.findIndex((v) => v === 0x43);
  if (start < 0) return [];
  const codes = [];
  const letters = ['P', 'C', 'B', 'U'];

  for (let i = start + 1; i + 1 < bytes.length; i += 2) {
    const a = bytes[i];
    const b = bytes[i + 1];
    if (!a && !b) continue;
    const code = `${letters[(a >> 6) & 3]}${((a >> 4) & 3).toString(16).toUpperCase()}${(a & 0x0f).toString(16).toUpperCase()}${((b >> 4) & 0x0f).toString(16).toUpperCase()}${(b & 0x0f).toString(16).toUpperCase()}`;
    codes.push(code);
  }
  return codes;
}

function friendlyDtc(code) {
  const known = {
    P0117: 'Sensor de temperatura do líquido: sinal baixo.',
    P0118: 'Sensor de temperatura do líquido: sinal alto.',
    P0100: 'Circuito do sensor de fluxo de ar (MAF).',
    P0101: 'Faixa/desempenho do sensor MAF.',
    P0300: 'Falhas de ignição aleatórias/múltiplas.',
    P0301: 'Falha de ignição no cilindro 1.',
    P0302: 'Falha de ignição no cilindro 2.',
    P0303: 'Falha de ignição no cilindro 3.',
    P0304: 'Falha de ignição no cilindro 4.',
  };
  return known[code] || 'Código OBD-II lido da ECU. Consulte a descrição técnica antes de reparar.';
}

export default function App() {
  const [device, setDevice] = useState(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [status, setStatus] = useState('Aguardando conexão com o ELM327');
  const [adapterName, setAdapterName] = useState('');
  const [rpm, setRpm] = useState(0);
  const [temp, setTemp] = useState(null);
  const [load, setLoad] = useState(null);
  const [speed, setSpeed] = useState(null);
  const [throttle, setThrottle] = useState(null);
  const [voltage, setVoltage] = useState('--');
  const [dtcs, setDtcs] = useState([]);
  const [history, setHistory] = useState([]);
  const scale = useRef(new Animated.Value(1)).current;
  const rxBuffer = useRef('');
  const pending = useRef(null);
  const deviceRef = useRef(null);
  const telemetryBusy = useRef(false);

  const animateButton = useCallback(() => {
    Animated.sequence([
      Animated.timing(scale, { toValue: 0.96, duration: 80, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 80, useNativeDriver: true }),
    ]).start();
  }, [scale]);

  const finishPending = useCallback((data) => {
    if (!pending.current) return;
    const p = pending.current;
    pending.current = null;
    clearTimeout(p.timer);
    p.resolve(data);
  }, []);

  const handleData = useCallback((event) => {
    const chunk = String(event?.data ?? '');
    rxBuffer.current += chunk;

    if (rxBuffer.current.includes('>')) {
      const response = rxBuffer.current;
      rxBuffer.current = '';
      finishPending(response);
    }
  }, [finishPending]);

  const sendCommand = useCallback(async (command, timeout = ELM_TIMEOUT_MS) => {
    const d = deviceRef.current;
    if (!d) throw new Error('ELM327 não conectado.');

    if (pending.current) throw new Error('O ELM327 ainda está respondendo ao comando anterior.');

    rxBuffer.current = '';
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.current = null;
        reject(new Error(`Sem resposta para ${command}.`));
      }, timeout);
      pending.current = { resolve, reject, timer };
    });

    try {
      await d.write(`${command}\r`);
    } catch (error) {
      if (pending.current) {
        const p = pending.current;
        pending.current = null;
        clearTimeout(p.timer);
        p.reject(error);
      }
      throw error;
    }
    return responsePromise;
  }, []);

  const initializeElm = useCallback(async () => {
    setStatus('Inicializando ELM327...');

    const initCommands = [
      ['ATZ', 5000],
      ['ATE0', 2500],
      ['ATL0', 2500],
      ['ATS0', 2500],
      ['ATH0', 2500],
      ['ATSP0', 5000],
    ];

    for (const [cmd, timeout] of initCommands) {
      try {
        await sendCommand(cmd, timeout);
      } catch (e) {
        if (cmd === 'ATZ') throw e;
      }
      await sleep(150);
    }

    setStatus('ELM327 inicializado • protocolo automático');
  }, [sendCommand]);

  const connectObd = useCallback(async () => {
    animateButton();
    if (busy) return;
    setBusy(true);

    try {
      setStatus('Procurando ELM327 pareado...');
      const enabled = await RNBluetoothClassic.isBluetoothEnabled();
      if (!enabled) {
        throw new Error('Bluetooth está desligado. Ative o Bluetooth do Android e tente novamente.');
      }

      const paired = await RNBluetoothClassic.getBondedDevices();
      const obd = paired.find((d) => {
        const name = String(d?.name || '').toUpperCase();
        return /ELM327|OBD|OBDII|V-LINK|VLINK|KONNWEI|VGATE/.test(name);
      });

      if (!obd) {
        throw new Error('Nenhum ELM327/OBD2 pareado foi encontrado. Primeiro pareie o adaptador nas configurações Bluetooth do Android.');
      }

      setStatus(`Conectando em ${obd.name || obd.address}...`);
      deviceRef.current = obd;

      if (typeof obd.onDataReceived === 'function') {
        obd.onDataReceived(handleData);
      }

      const ok = await obd.connect();
      if (!ok) throw new Error('O ELM327 recusou a conexão.');

      setDevice(obd);
      setAdapterName(obd.name || 'ELM327');
      setConnected(true);

      await initializeElm();

      // Teste real de comunicação com a ECU.
      const protocol = await sendCommand('ATDP', 3000);
      setStatus(`ECU conectada • ${cleanElmText(protocol).replace(/\s+/g, ' ').trim() || 'protocolo detectado'}`);

      try {
        await readDtcs();
      } catch (_) {
        // DTC é opcional na conexão inicial.
      }
    } catch (error) {
      setConnected(false);
      deviceRef.current = null;
      setStatus('Falha na conexão');
      Alert.alert('Erro OBD2', error?.message || String(error));
    } finally {
      setBusy(false);
    }
  }, [animateButton, busy, handleData, initializeElm, sendCommand]);

  const disconnectObd = useCallback(async () => {
    try {
      await deviceRef.current?.disconnect();
    } catch (_) {}
    deviceRef.current = null;
    setDevice(null);
    setConnected(false);
    setIsScanning(false);
    setStatus('Desconectado');
    setAdapterName('');
  }, []);

  const readDtcs = useCallback(async () => {
    if (!deviceRef.current) throw new Error('Conecte o ELM327 primeiro.');
    setStatus('Lendo códigos da ECU...');
    const response = await sendCommand('03', 5000);
    const codes = parseDtcResponse(response);
    setDtcs(codes.map((code) => ({ code, desc: friendlyDtc(code), module: 'ECU / OBD-II' })));
    setStatus(codes.length ? `${codes.length} código(s) encontrado(s)` : 'ECU sem DTCs OBD-II');
    return codes;
  }, [sendCommand]);

  const clearDtcs = useCallback(async () => {
    if (!deviceRef.current) {
      Alert.alert('OBD2', 'Conecte o ELM327 primeiro.');
      return;
    }

    Alert.alert(
      'Apagar falhas',
      'O comando 04 apaga códigos de diagnóstico e pode apagar dados de diagnóstico armazenados. Deseja continuar?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Apagar',
          style: 'destructive',
          onPress: async () => {
            try {
              setStatus('Enviando comando de limpeza...');
              const response = await sendCommand('04', 5000);
              setDtcs([]);
              setStatus(`Comando de limpeza enviado • ${cleanElmText(response).replace(/\s+/g, ' ').trim() || 'sem detalhes'}`);
            } catch (e) {
              Alert.alert('Falha ao apagar', e.message);
            }
          },
        },
      ],
    );
  }, [sendCommand]);

  const pollTelemetry = useCallback(async () => {
    if (!deviceRef.current || telemetryBusy.current) return;
    telemetryBusy.current = true;

    try {
      const rpmR = await sendCommand('010C');
      const tempR = await sendCommand('0105');
      const loadR = await sendCommand('0104');
      const speedR = await sendCommand('010D');
      const throttleR = await sendCommand('0111');
      const voltageR = await sendCommand('0142');

      const newRpm = parseRpm(rpmR);
      const newTemp = parseCoolant(tempR);
      const newLoad = parseLoad(loadR);
      const newSpeed = parseSpeed(speedR);
      const newThrottle = parseThrottle(throttleR);
      const newVoltage = parseVoltage(voltageR);

      if (newRpm != null) setRpm(newRpm);
      if (newTemp != null) {
        setTemp(newTemp);
        setHistory((prev) => [...prev.slice(-19), newTemp]);
      }
      if (newLoad != null) setLoad(newLoad);
      if (newSpeed != null) setSpeed(newSpeed);
      if (newThrottle != null) setThrottle(newThrottle);
      if (newVoltage != null) setVoltage(newVoltage);

      setStatus('Monitoramento OBD-II ao vivo');
    } catch (e) {
      setStatus(`Leitura interrompida: ${e.message}`);
      setIsScanning(false);
    } finally {
      telemetryBusy.current = false;
    }
  }, [sendCommand]);

  useEffect(() => {
    if (!connected || !isScanning) return undefined;
    const id = setInterval(pollTelemetry, POLL_MS);
    pollTelemetry();
    return () => clearInterval(id);
  }, [connected, isScanning, pollTelemetry]);

  useEffect(() => {
    return () => {
      try {
        deviceRef.current?.disconnect();
      } catch (_) {}
    };
  }, []);

  const toggleMonitoring = () => {
    animateButton();
    if (!connected) {
      Alert.alert('OBD2', 'Conecte o ELM327 antes de iniciar o monitoramento.');
      return;
    }
    setIsScanning((v) => !v);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>NEXUS <Text style={styles.model}>207 PRO</Text></Text>
          <Text style={styles.vehicle}>PEUGEOT 207 • 1.4 8V • 2009/2010</Text>
        </View>
        <TouchableOpacity
          style={[styles.btnConn, connected && styles.btnConnActive]}
          onPress={connected ? disconnectObd : connectObd}
          disabled={busy}
        >
          <Text style={styles.btnText}>{busy ? 'CONECTANDO...' : connected ? '● ECU ONLINE' : 'CONECTAR OBD2'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.statusCard, connected ? styles.okCard : styles.warnCard]}>
          <Text style={styles.label}>STATUS</Text>
          <Text style={styles.statusText}>{status}</Text>
          {adapterName ? <Text style={styles.adapter}>Adaptador: {adapterName}</Text> : null}
        </View>

        <View style={styles.mainCard}>
          <Text style={styles.label}>TELEMETRIA REAL DA ECU</Text>
          <Text style={styles.rpmValue}>{rpm} <Text style={styles.rpmUnit}>RPM</Text></Text>

          <View style={styles.grid}>
            <Metric label="ARREFECIMENTO" value={temp == null ? '--' : `${temp}°C`} alert={temp > 97} />
            <Metric label="CARGA MOTOR" value={load == null ? '--' : `${load}%`} />
            <Metric label="VELOCIDADE" value={speed == null ? '--' : `${speed} km/h`} />
            <Metric label="BORBOLETA" value={throttle == null ? '--' : `${throttle}%`} />
            <Metric label="TENSÃO ECU" value={voltage} />
            <Metric label="PROTOCOLO" value="AUTO" />
          </View>
        </View>

        <View style={styles.chartArea}>
          <Text style={styles.labelCenter}>TEMPERATURA — ÚLTIMAS LEITURAS</Text>
          <View style={styles.barContainer}>
            {Array.from({ length: 20 }).map((_, i) => {
              const value = history[i] ?? temp ?? 40;
              return (
                <View
                  key={i}
                  style={[
                    styles.bar,
                    {
                      height: Math.max(8, Math.min(70, (value - 40) * 1.2)),
                      backgroundColor: value > 97 ? '#ff4444' : '#00ff88',
                    },
                  ]}
                />
              );
            })}
          </View>
        </View>

        <View style={styles.diagContainer}>
          <Text style={styles.label}>DIAGNÓSTICO OBD-II REAL</Text>
          {dtcs.length ? (
            dtcs.map((item) => (
              <View key={item.code} style={styles.errorBox}>
                <Text style={styles.errorModule}>[{item.module}]</Text>
                <Text style={styles.errorText}>⚠️ {item.code}: {item.desc}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.noErrorText}>Nenhum DTC OBD-II armazenado ou leitura ainda não realizada.</Text>
          )}

          <View style={styles.diagButtonsRow}>
            <Animated.View style={{ flex: 1, transform: [{ scale }] }}>
              <TouchableOpacity style={styles.smallBtn} onPress={readDtcs}>
                <Text style={styles.smallBtnText}>LER FALHAS</Text>
              </TouchableOpacity>
            </Animated.View>
            <Animated.View style={{ flex: 1, transform: [{ scale }] }}>
              <TouchableOpacity style={[styles.smallBtn, styles.clearBtn]} onPress={clearDtcs}>
                <Text style={styles.smallBtnText}>APAGAR DTC</Text>
              </TouchableOpacity>
            </Animated.View>
          </View>
        </View>

        <Animated.View style={{ transform: [{ scale }] }}>
          <TouchableOpacity
            style={[styles.scanBtn, isScanning && styles.scanBtnActive]}
            onPress={toggleMonitoring}
          >
            <Text style={[styles.scanBtnText, isScanning && { color: '#fff' }]}>
              {isScanning ? 'PARAR MONITORAMENTO AO VIVO' : 'INICIAR MONITORAMENTO AO VIVO'}
            </Text>
          </TouchableOpacity>
        </Animated.View>

        <Text style={styles.note}>
          Este modo usa OBD-II genérico via ELM327. BSI/BSM e códigos específicos Peugeot não são simulados nesta versão.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Metric({ label, value, alert }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.subValue, alert && styles.textAlert]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050505' },
  header: { padding: 18, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#0a0a0a' },
  brand: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  model: { color: '#00ff88', fontSize: 12 },
  vehicle: { color: '#666', fontSize: 9, marginTop: 3 },
  btnConn: { backgroundColor: '#1a1a1a', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#333' },
  btnConnActive: { backgroundColor: '#00331b', borderColor: '#00ff88' },
  btnText: { color: '#fff', fontSize: 10, fontWeight: 'bold' },
  scroll: { padding: 15, paddingBottom: 30 },
  statusCard: { padding: 12, borderRadius: 12, marginBottom: 15, borderWidth: 1 },
  okCard: { backgroundColor: '#0a1a10', borderColor: '#00331b' },
  warnCard: { backgroundColor: '#17120a', borderColor: '#554411' },
  statusText: { color: '#fff', fontSize: 12, fontWeight: 'bold', marginTop: 4 },
  adapter: { color: '#777', fontSize: 10, marginTop: 4 },
  mainCard: { backgroundColor: '#111', padding: 18, borderRadius: 16, borderLeftWidth: 5, borderLeftColor: '#00ff88', marginBottom: 15 },
  label: { color: '#777', fontSize: 9, fontWeight: 'bold', letterSpacing: 1.1 },
  labelCenter: { color: '#777', fontSize: 9, textAlign: 'center', marginBottom: 10, fontWeight: 'bold' },
  rpmValue: { color: '#fff', fontSize: 46, fontWeight: '900', marginVertical: 4 },
  rpmUnit: { fontSize: 15, color: '#00ff88', fontWeight: 'bold' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 10 },
  metric: { width: '31%', marginBottom: 14 },
  subValue: { color: '#fff', fontSize: 16, fontWeight: 'bold', marginTop: 2 },
  textAlert: { color: '#ff4444' },
  chartArea: { backgroundColor: '#0a0a0a', padding: 15, borderRadius: 14, borderWidth: 1, borderColor: '#1a1a1a', marginBottom: 15 },
  barContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', height: 70, marginTop: 5 },
  bar: { width: 7, borderRadius: 3 },
  diagContainer: { backgroundColor: '#111', padding: 15, borderRadius: 14, borderWidth: 1, borderColor: '#222', marginBottom: 15 },
  errorBox: { backgroundColor: '#1c0a0a', padding: 8, borderRadius: 8, marginTop: 8, borderWidth: 1, borderColor: '#401010' },
  errorModule: { color: '#ff8888', fontSize: 10, fontWeight: 'bold' },
  errorText: { color: '#ffbbbb', fontSize: 11, marginTop: 2 },
  noErrorText: { color: '#00ff88', fontSize: 11, marginTop: 8 },
  diagButtonsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 15, gap: 10 },
  smallBtn: { backgroundColor: '#222', padding: 12, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#333' },
  clearBtn: { backgroundColor: '#331111', borderColor: '#552222' },
  smallBtnText: { color: '#fff', fontSize: 10, fontWeight: 'bold' },
  scanBtn: { backgroundColor: '#00ff88', padding: 16, borderRadius: 12, alignItems: 'center', marginBottom: 12 },
  scanBtnActive: { backgroundColor: '#cc0000' },
  scanBtnText: { color: '#000', fontWeight: '900', fontSize: 13, letterSpacing: 0.4 },
  note: { color: '#555', fontSize: 9, textAlign: 'center', lineHeight: 14, marginBottom: 10 },
});
