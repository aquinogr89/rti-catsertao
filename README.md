# Cadastro de RTI — CAT Sertão

Site estático para cadastro e visualização em mapa de pontos de Reserva Técnica de
Incêndio (RTI) do CAT Sertão — Centro de Atividades Técnicas do Sertão (CBMPE).

Site independente, sem nenhum link de/para o site principal do CAT Sertão — mas
compartilha o **mesmo backend** (Google Apps Script) e o **mesmo login** do site
principal ([aquinogr89/catsertao](https://github.com/aquinogr89/catsertao)): o
mapa é público para consulta, mas **cadastrar** um ponto de RTI exige estar
logado no site principal com um perfil autorizado (`admin_master`, `admin` ou
`user1`). Veja a seção [Autenticação e perfis](#autenticação-e-perfis) abaixo.

## Estrutura

```
index.html            página única (mapa + modal de cadastro)
style.css              estilos (paleta extraída do site principal)
app.js                  lógica: mapa (Leaflet + OpenStreetMap), geolocalização, cadastro
apps-script/Code.gs    backend: doGet (mapa público) + doPost (cadastro de RTI, autenticado)
apps-script/Auth.gs    backend: login, sessões, usuários, termo de compromisso, LOG de auditoria
CAT-SERTAO-SEM-FUNDO.png  logo usado no cabeçalho/rodapé
```

`Code.gs` e `Auth.gs` vivem no **mesmo projeto** Apps Script (mesma planilha,
mesma implantação `/exec`) — não são dois backends separados.

## 1. Implantar o backend (Google Apps Script)

1. Crie uma Planilha Google nova (ou reutilize uma existente) — ela vai
   guardar as abas `RTI`, `USUARIOS`, `SESSOES` e `LOG`.
2. No menu da planilha: **Extensões → Apps Script**.
3. Crie dois arquivos de script com esses nomes exatos e cole o conteúdo
   correspondente deste projeto:
   - `Code.gs` ← [`apps-script/Code.gs`](apps-script/Code.gs)
   - `Auth.gs` ← [`apps-script/Auth.gs`](apps-script/Auth.gs)
4. Salve o projeto (nome sugerido: `RTI CAT Sertão`).
5. **Defina a senha inicial do admin_master (obrigatório, antes do passo 6):**
   - Vá em **Configurações do projeto** (ícone de engrenagem) → **Propriedades do script**.
   - Adicione a propriedade `SENHA_INICIAL_ADMIN` com a senha que você quer
     usar no primeiro login. Essa senha **não pode e não deve** ser colocada
     em nenhum arquivo do repositório.
6. No editor, selecione a função `setupInicial` (no arquivo `Auth.gs`) no
   seletor de funções e clique em **Executar**. Isso cria as abas
   `USUARIOS`, `SESSOES`, `LOG` (e `RTI`, se ainda não existir) e cadastra o
   usuário `geraldo.reis` com perfil `admin_master`, usando a senha da
   propriedade `SENHA_INICIAL_ADMIN`.
   - Na primeira execução o Google vai pedir autorização — é a sua própria
     planilha, pode autorizar.
   - **Depois do primeiro login, troque essa senha pelo painel "Minha
     Conta"** no site principal — ela não deve continuar sendo a senha de
     produção por muito tempo.
7. Clique em **Implantar → Nova implantação**.
   - Tipo: **App da Web**.
   - Executar como: **Eu** (sua conta).
   - Quem pode acessar: **Qualquer pessoa**.
8. Autorize as permissões solicitadas.
9. Copie a **URL do app da Web** (termina em `/exec`) — é a mesma URL que
   vai em `SHEETS_API_URL` (`app.js`, neste projeto) **e** em
   `APPS_SCRIPT_URL` (`index.html`, no repositório `catsertao`).

Sempre que `Code.gs` ou `Auth.gs` forem alterados, é preciso reimplantar:
**Implantar → Gerenciar implantações → (ícone de lápis na implantação ativa)
→ Versão: Nova versão → Implantar.** Isso atualiza o comportamento **sem
trocar a URL `/exec`** — os dois sites continuam apontando para o mesmo
endereço.

## Autenticação e perfis

Todo login, hash de senha, verificação de token e checagem de permissão
acontece no Apps Script (servidor) — nunca no HTML/JS publicado no GitHub
Pages, que é público. Perfis:

| Perfil         | Pode fazer |
|----------------|------------|
| `admin_master` | Tudo: cadastrar RTI, ver Termo de Compromisso, gerenciar **qualquer** usuário (inclusive outros admins), ver o LOG de auditoria. |
| `admin`        | Cadastrar RTI, ver Termo de Compromisso, criar/desativar apenas usuários `user1`/`user2` (nunca outro admin). |
| `user1`        | Apenas cadastrar RTI (e ver o mapa, que é público). |
| `user2`        | Apenas navegação básica do site principal (sem RTI, sem Termo). |

O botão **"Cadastrar RTI"** deste site verifica, no navegador, se existe uma
sessão válida em `sessionStorage` (compartilhada com o site principal por
estarem sob o mesmo domínio `aquinogr89.github.io`); se não houver, redireciona
para o login do site principal. O servidor **sempre** revalida o token e o
perfil a cada cadastro — a checagem no navegador é só para a experiência do
usuário, não é a barreira de segurança real.

## Campos do cadastro e cor do marcador

Além de nome, capacidade e hidrantes, o formulário de cadastro tem:

- **Possui AVCB válido** (checkbox) — ao marcar, exibe o campo **Data de
  validade do AVCB** (obrigatório enquanto o checkbox estiver marcado).
- **Quantidade de pavimentos da edificação** (opcional, mínimo 1).
- **Área construída total (m²)** (opcional, aceita decimais, não negativo).
- **Altura da edificação (m)** (opcional, aceita decimais, não negativo).

A cor do marcador no mapa é **recalculada a cada carregamento** (nunca fica
"salva pronta"), comparando a data de validade do AVCB com a data atual:

- 🟢 **Verde** — possui AVCB e a validade é hoje ou uma data futura.
- 🔴 **Vermelho** — não possui AVCB, ou a validade já passou (vencido).

O popup do marcador mostra o status do AVCB ("Válido até dd/mm/aaaa",
"Vencido desde dd/mm/aaaa" ou "Não possui AVCB") e os campos de pavimentos,
área construída e altura, quando preenchidos. Pontos cadastrados antes
dessa funcionalidade (sem esses campos) continuam funcionando normalmente:
aparecem em vermelho (equivalente a "não possui AVCB") e sem essas linhas
extras no popup — a coluna nova é criada automaticamente pela mesma
migração que já cuidava de `cadastrado_por` (ver `rtiSheet_()` em
`apps-script/Code.gs`).

## 2. Configurar o front-end

O mapa usa **Leaflet + OpenStreetMap** — não precisa de chave nem de cartão
de crédito. Abra [`app.js`](app.js) e edite a constante no topo do arquivo:

```js
const SHEETS_API_URL = "";    // URL /exec do Apps Script (passo 1)
```

- **`SHEETS_API_URL` vazia** → o site funciona em **modo local**: os
  cadastros ficam salvos apenas no `localStorage` do navegador (não são
  compartilhados entre dispositivos) e um selo **"Modo teste"** aparece no
  rodapé. Cole a URL do passo 1 para conectar à planilha real. Neste modo,
  a checagem de login continua acontecendo no navegador, mas sem validação
  real no servidor (não há servidor configurado).

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
- Cada ponto de RTI cadastrado grava o login de quem cadastrou na coluna
  `cadastrado_por` da aba `RTI`, e o evento fica registrado na aba `LOG`
  (ação `cadastro_rti`), visível para `admin_master` no painel "LOG" do
  site principal.
- Sessões de login expiram sozinhas em 8h (aba `SESSOES`); não é preciso
  fazer nada manualmente para "deslogar" usuários inativos.
