# NEXUS 207 PRO — OBD2 Bluetooth

Projeto React Native/Expo preparado para o Peugeot 207 1.4 8V 2009/2010 e adaptador ELM327 Mini Bluetooth.

## O que foi alterado

- Removida a telemetria aleatória/simulada.
- Comunicação Bluetooth Classic com ELM327.
- Inicialização do ELM327 com comandos AT.
- Detecção automática de protocolo (`ATSP0`).
- Leitura real de RPM (`010C`).
- Temperatura do líquido de arrefecimento (`0105`).
- Carga do motor (`0104`).
- Velocidade (`010D`).
- Posição da borboleta (`0111`).
- Tensão do módulo, quando o PID 42 for suportado (`0142`).
- Leitura de DTCs genéricos (`03`).
- Comando de apagar DTCs (`04`), somente quando suportado pela ECU/adaptador.
- Painel de status e histórico térmico.
- BSI/BSM não é mais falsamente apresentado como diagnóstico real.

## Importante

Esta primeira versão é OBD-II genérica. Ela não promete acesso a BSI/BSM Peugeot. O ELM327 Mini pode não conseguir acessar módulos específicos de carroceria.

Os PIDs podem ser recusados pela ECU. Nesse caso o aplicativo mantém `--` para aquele dado em vez de inventar um valor.

## Compatibilidade

O projeto usa Expo SDK 54 e deixa a New Architecture desativada para favorecer a compatibilidade com a biblioteca Bluetooth Classic. A biblioteca `react-native-bluetooth-classic` declara suporte a React Native >= 0.73 na série 1.70.x.

## Como gerar o APK sem instalar Android Studio/SDK no PC

A compilação é feita na nuvem pelo EAS Build.

### Opção recomendada para quem não quer instalar nada no PC

1. Crie uma conta em GitHub e outra em Expo.
2. Crie um repositório no GitHub pelo navegador.
3. Envie os arquivos deste projeto para o repositório usando o botão "Add file > Upload files".
4. Abra um GitHub Codespace pelo navegador para esse repositório.
5. No terminal do Codespace, execute:

   `npx eas-cli@latest login`

6. Depois:

   `npx eas-cli@latest build:configure`

7. Quando solicitado, escolha Android.
8. Faça o primeiro build:

   `npx eas-cli@latest build --platform android --profile preview`

O APK será compilado nos servidores do Expo. Depois, abra o build no painel do Expo e use o link/QR Code para instalar no Android.

## Pareamento do ELM327

Antes de abrir o NEXUS 207 PRO:

1. Ligue o ELM327 na tomada OBD do Peugeot.
2. Ligue a ignição.
3. Abra as configurações Bluetooth do Android.
4. Pareie o adaptador.
5. Se pedir PIN, use o PIN impresso no adaptador/manual (muitos clones usam 1234 ou 0000, mas não assuma; confira o seu).
6. Abra o NEXUS 207 PRO.
7. Toque em CONECTAR OBD2.
8. Depois de conectado, toque em INICIAR MONITORAMENTO AO VIVO.

## Primeiro teste

Com o carro parado e a ignição ligada, o aplicativo deve conseguir pelo menos estabelecer comunicação com o ELM327. Para telemetria, deixe o motor funcionando.

Se o app conectar ao ELM327 mas mostrar `--`, isso significa que o adaptador respondeu, porém aquele PID não foi aceito ou a resposta não foi interpretada. O próximo passo é registrar as respostas brutas do ELM327 para ajustar o parser especificamente ao seu carro.

## Segurança

Não use os valores do aplicativo como substituto de instrumentos originais do veículo. Temperatura, pressão, falhas elétricas e comandos de limpeza de DTC devem ser confirmados antes de qualquer reparo.

