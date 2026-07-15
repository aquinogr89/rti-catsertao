# Cadastro de RTI — CAT Sertão

Site estático para cadastro e visualização em mapa de pontos de Reserva Técnica de
Incêndio (RTI) do CAT Sertão — Centro de Atividades Técnicas do Sertão (CBMPE).

Site independente, sem nenhum link de/para o site principal do CAT Sertão.

## Estrutura

```
index.html          página única (mapa + modal de cadastro)
style.css            estilos (paleta extraída do site principal)
app.js                lógica: mapa (Leaflet + OpenStreetMap), geolocalização, cadastro
apps-script/Code.gs  backend (Google Apps Script + Planilha Google)
CAT-SERTAO-SEM-FUNDO.png  logo usado no cabeçalho/rodapé
```

## 1. Implantar o backend (Google Apps Script)

1. Crie uma Planilha Google nova (ou reutilize uma existente).
2. No menu da planilha: **Extensões → Apps Script**.
3. Apague o conteúdo padrão de `Code.gs` e cole o conteúdo de
   [`apps-script/Code.gs`](apps-script/Code.gs) deste projeto.
4. Salve o projeto (nome sugerido: `RTI CAT Sertão`).
5. Clique em **Implantar → Nova implantação**.
   - Tipo: **App da Web**.
   - Executar como: **Eu** (sua conta).
   - Quem pode acessar: **Qualquer pessoa**.
6. Autorize as permissões solicitadas (é a sua própria planilha).
7. Copie a **URL do app da Web** (termina em `/exec`).
8. O script cria automaticamente a aba `RTI` com o cabeçalho
   (`timestamp, lat, lng, nome, capacidade_litros, hidrante_fachada,
   hidrante_recalque, endereco`) na primeira execução — não é preciso criar
   a aba manualmente.

Sempre que o código do `Code.gs` for alterado, é preciso gerar uma
**nova implantação** (ou editar a implantação existente) para que as
mudanças entrem em vigor na URL publicada.

## 2. Configurar o front-end

O mapa usa **Leaflet + OpenStreetMap** — não precisa de chave nem de cartão
de crédito. Abra [`app.js`](app.js) e edite a constante no topo do arquivo:

```js
const SHEETS_API_URL = "";    // URL /exec do Apps Script (passo 1)
```

- **`SHEETS_API_URL` vazia** → o site funciona em **modo local**: os
  cadastros ficam salvos apenas no `localStorage` do navegador (não são
  compartilhados entre dispositivos) e um selo **"Modo teste"** aparece no
  rodapé. Cole a URL do passo 1 para conectar à planilha real.

## 3. Testar localmente

Com Node.js instalado:

```bash
npx serve .
```

Ou com Python:

```bash
python3 -m http.server 8080
```

Depois acesse a URL exibida no terminal (ex.: `http://localhost:3000` ou
`http://localhost:8080`) em um navegador — inclusive pelo celular, na mesma
rede Wi-Fi, usando o IP da máquina.

## 4. Publicar no GitHub Pages

1. Crie um repositório novo no GitHub (público) e envie os arquivos deste
   projeto para a branch `main`.
2. Em **Settings → Pages**, defina a fonte como branch `main`, pasta raiz (`/`).
3. O site ficará disponível em `https://<seu-usuário>.github.io/<repositório>/`.

## Observações

- A geolocalização do dispositivo requer HTTPS (GitHub Pages já serve por
  HTTPS) ou `localhost` — em `http://` "normal" o navegador bloqueia a API.
- A geocodificação reversa usa o Nominatim (OpenStreetMap) — use com
  moderação, pois esse serviço público tem limite de requisições por
  segundo.
