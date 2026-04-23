# m4aOggToMp3

Aplicacao web local para converter arquivos .m4a e .ogg para .mp3 com foco em alta qualidade, exportando sempre um ZIP com todos os arquivos convertidos.

## Recursos

- Interface web simples em http://localhost:9090
- Conversao em lote de arquivos .m4a e .ogg para .mp3
- Download sempre em arquivo ZIP
- Progresso em tempo real (geral e arquivo a arquivo)
- Qualidade de audio selecionavel na interface
	- CBR 320 kbps (taxa fixa)
	- VBR V0 (qualidade maxima variavel)
	- CBR 256 kbps
	- CBR 192 kbps
- Atributos adicionais selecionaveis
	- Taxa de amostragem: 48000, 44100 ou manter original
	- Canais: estereo, mono ou manter original
	- Preservar metadados ID3

## Requisitos

- Node.js 18+
- npm

Observacao: nao e necessario instalar ffmpeg manualmente, pois o projeto usa ffmpeg-static e ffprobe-static.

## Instalacao

		npm install

## Execucao

		npm start

Por padrao, o comando acima libera automaticamente a porta 9090 antes de iniciar o servidor.

Scripts disponiveis:

- npm start: libera a porta 9090 e inicia
- npm run start:clean: equivalente ao npm start
- npm run start:raw: inicia sem tentar liberar a porta

Depois, abra no navegador:

		http://localhost:9090

## Como usar

1. Selecione um ou varios arquivos .m4a/.ogg
2. Escolha o perfil de qualidade MP3
3. Ajuste taxa de amostragem e canais (se desejar)
4. Marque ou desmarque preservacao de metadados
5. Clique em Converter agora
6. Aguarde o progresso em tempo real e baixe o ZIP final

## Qualidade e bitrate

- O limite tecnico de bitrate no formato MP3 e 320 kbps.
- Para forcar taxa fixa, use CBR 320 kbps.
- VBR V0 prioriza qualidade perceptiva com bitrate variavel.
- Em alguns visualizadores de propriedades, o valor exibido pode parecer medio em vez de instantaneo.

## Endpoints

### POST /convert

Recebe arquivos e retorna ZIP com os MP3 convertidos.

Campos de formulario aceitos:

- jobId: identificador do job (opcional)
- qualityPreset: cbr-320, vbr-v0, cbr-256, cbr-192
- sampleRate: 48000, 44100, source
- channels: 2, 1, source
- preserveMetadata: 1 ou 0
- audioFiles: um ou varios arquivos .m4a/.ogg

Exemplo com curl:

		curl -o audios-convertidos-mp3.zip \
			-F "jobId=demo-job" \
			-F "qualityPreset=cbr-320" \
			-F "sampleRate=48000" \
			-F "channels=2" \
			-F "preserveMetadata=1" \
			-F "audioFiles=@/caminho/arquivo1.ogg" \
			-F "audioFiles=@/caminho/arquivo2.m4a" \
			http://localhost:9090/convert

### GET /progress/:jobId

Endpoint SSE (Server-Sent Events) para acompanhar progresso do job em tempo real.

Estados principais enviados:

- waiting
- queued
- processing
- zipping
- done
- error

## Estrutura do projeto

- server.js: servidor Express, conversao ffmpeg, ZIP e progresso SSE
- public/index.html: interface web
- public/styles.css: estilos da interface

## Solucao de problemas

- Porta 9090 ocupada:
	- finalize o processo atual da porta e rode npm start novamente.
- Progresso nao aparece:
	- recarregue com Ctrl+F5 para evitar cache antigo do JavaScript.
- Bitrate diferente do esperado:
	- selecione CBR 320 kbps para taxa fixa mais alta no MP3.

## Licenca

MIT