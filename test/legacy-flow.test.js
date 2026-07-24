'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  after,
  beforeEach,
  test,
} = require('node:test');
const assert = require('node:assert/strict');

const repositoryRoot = path.resolve(__dirname, '..');
const originalCwd = process.cwd();
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-prod-legacy-'));
const assetsDir = path.join(sandboxRoot, 'assets');

fs.mkdirSync(assetsDir, { recursive: true });
for (const fileName of [
  'capa_bem_vindos.jpg',
  'capa-mostruario.jpg',
  'tabela-cores-v2.jpg',
  'tabela-espessura.jpg',
  'tabela-profundidade-3mm.jpg',
]) {
  fs.writeFileSync(path.join(assetsDir, fileName), 'legacy-test', 'utf8');
}

process.chdir(sandboxRoot);
process.env.MOCK_MODE = 'true';
process.env.MIN_REPLY_DELAY_MS = '0';
process.env.MAX_REPLY_DELAY_MS = '0';
process.env.ENABLE_TYPING = 'false';
process.env.ENABLE_CONTACT_LABELS = 'false';
process.env.ENABLE_CONTACT_NOTES = 'true';
process.env.ENABLE_TEST_COMMANDS = 'false';
process.env.ASSETS_DIR = 'assets';
process.env.BEM_VINDOS_IMAGE_BASENAME = 'capa_bem_vindos';
process.env.MOSTRUARIO_LETREIRO_IMAGE_BASENAME = 'capa-mostruario';
process.env.ASSET_TABELA_CORES_BASENAME = 'tabela-cores-v2';
process.env.ASSET_TABELA_ESPESSURA_BASENAME = 'tabela-espessura';
process.env.ASSET_TABELA_PROFUNDIDADE_BASENAME = 'tabela-profundidade-3mm';
process.env.BEM_VINDOS_LINK_URL = 'https://personalizeseuambiente.com.br/bem-vindos';
process.env.MOSTRUARIO_LINK_URL = 'https://personalizeseuambiente.com.br/mostruario-letreiros';

const { processCustomerMessage } = require(path.join(repositoryRoot, 'src/flow/customerFlow.js'));
const { installMessageExperience } = require(path.join(repositoryRoot, 'src/core/messageExperience.js'));
const Store = require(path.join(repositoryRoot, 'src/services/leadStore.js'));

let sequence = 0;

function createRecordingChannel() {
  const events = [];
  const nextResult = (prefix) => ({
    id: { _serialized: `${prefix}-${++sequence}` },
    ack: 1,
  });

  const client = {
    async sendText(chatId, text) {
      events.push({ type: 'text', chatId, text: String(text || '') });
      return nextResult('text');
    },
    async sendImage(chatId, filePath, fileName, caption = '') {
      events.push({
        type: 'image',
        chatId,
        filePath,
        fileName: fileName || path.basename(filePath),
        caption: String(caption || ''),
      });
      return nextResult('image');
    },
    async sendListMessage(chatId, payload) {
      events.push({ type: 'list', chatId, payload });
      return nextResult('list');
    },
    async startTyping() { return true; },
    async stopTyping() { return true; },
  };

  const channel = {
    client,
    async sendText(clientId, text) {
      return client.sendText(clientId, text);
    },
    async sendImage(clientId, filePath, caption = '') {
      return client.sendImage(clientId, filePath, path.basename(filePath), caption);
    },
    async sendDocument(clientId, filePath, fileName, caption = '') {
      events.push({ type: 'document', clientId, filePath, fileName, caption });
      return nextResult('document');
    },
    async setContactNote(clientId, note) {
      events.push({ type: 'note', clientId, note: String(note || '') });
      return true;
    },
    async applyContactLabel(clientId, label) {
      events.push({ type: 'label', clientId, label });
      return true;
    },
    async markUnread(clientId) {
      events.push({ type: 'unread', clientId });
      return true;
    },
  };

  installMessageExperience(channel);
  return { channel, events };
}

function listTitle(event) {
  return event?.payload?.sections?.[0]?.title || '';
}

function listRowIds(event) {
  return (event?.payload?.sections || [])
    .flatMap((section) => section.rows || [])
    .map((row) => row.id || row.rowId)
    .filter(Boolean);
}

async function answer(channel, clientId, text, messages = []) {
  return processCustomerMessage({ clientId, text, channel, messages });
}

beforeEach(() => {
  Store.resetSystem();
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('legado: primeira conversa envia saudação, capa de boas-vindas e lista de serviços', async () => {
  const clientId = '5531999990001@c.us';
  const { channel, events } = createRecordingChannel();

  await answer(channel, clientId, 'Oi, meu nome é Emilly');

  const session = Store.getSession(clientId);
  assert.equal(session.etapa, 'escolher_servico');
  assert.equal(session.dados.origem, 'whatsapp');
  assert.match(events[0]?.text || '', /Bem-vindo\(a\) ao Canal de Atendimento da Personalize!/i);
  assert.equal(events[1]?.type, 'image');
  assert.equal(events[1]?.fileName, 'capa_bem_vindos.jpg');
  assert.equal(events[1]?.caption, 'https://personalizeseuambiente.com.br/bem-vindos');
  assert.equal(events[2]?.type, 'list');
  assert.equal(listTitle(events[2]), 'Serviços');
  assert.deepEqual(listRowIds(events[2]), ['serv_letreiro', 'serv_plotagem', 'serv_outros']);
});

test('legado: escolha de letreiro envia mostruário e abre o tipo de acrílico', async () => {
  const clientId = '5531999990002@c.us';
  const { channel, events } = createRecordingChannel();

  await answer(channel, clientId, 'Oi');
  events.length = 0;
  await answer(channel, clientId, 'serv_letreiro');

  const session = Store.getSession(clientId);
  assert.equal(session.etapa, 'tipo_acrilico');
  assert.equal(session.dados.flow, 'letreiro');
  assert.equal(events[0]?.type, 'image');
  assert.equal(events[0]?.fileName, 'capa-mostruario.jpg');
  assert.equal(events[0]?.caption, 'https://personalizeseuambiente.com.br/mostruario-letreiros');
  assert.equal(events[1]?.type, 'list');
  assert.equal(listTitle(events[1]), 'Tipo de acrílico');
  assert.deepEqual(listRowIds(events[1]), ['acr_colorido', 'acr_pintado']);
});

test('legado: fluxo completo de letreiro preserva etapas, dados e nota final', async () => {
  const clientId = '5531999990003@c.us';
  const { channel, events } = createRecordingChannel();

  await answer(channel, clientId, 'Oi');
  await answer(channel, clientId, 'serv_letreiro');
  await answer(channel, clientId, 'acr_colorido');
  assert.equal(Store.getSession(clientId).etapa, 'cor_basica_qtd');

  await answer(channel, clientId, 'corq_1');
  assert.equal(Store.getSession(clientId).etapa, 'cor_basica_tipo');

  await answer(channel, clientId, 'cor_tipo_solida');
  assert.equal(Store.getSession(clientId).etapa, 'cor_basica_select_solida');

  await answer(channel, clientId, 'cor_preto');
  assert.equal(Store.getSession(clientId).etapa, 'tamanho');
  assert.deepEqual(Store.getSession(clientId).dados.coresSelecionadas, ['Preto']);

  await answer(channel, clientId, '100x50');
  assert.equal(Store.getSession(clientId).etapa, 'espessura_extra_3mm');
  assert.deepEqual(Store.getSession(clientId).dados.medida, { largura: 100, altura: 50 });

  await answer(channel, clientId, 'esp3_keep');
  assert.equal(Store.getSession(clientId).etapa, 'arte_menu');

  await answer(channel, clientId, 'art_ideia');
  assert.equal(Store.getSession(clientId).etapa, 'arte_coleta');
  assert.equal(Store.getSession(clientId).dados.arteModo, 'descrever');

  await answer(channel, clientId, 'Logo preta com o nome EVA');
  assert.equal(Store.getSession(clientId).etapa, 'cidade');

  await answer(channel, clientId, 'Betim/MG');
  assert.equal(Store.getSession(clientId).etapa, 'envio');
  const deliveryList = [...events].reverse().find((event) => event.type === 'list' && listTitle(event) === 'Envio');
  assert.ok(deliveryList, 'deve enviar a lista de entrega');
  assert.equal(listRowIds(deliveryList).includes('envio_instalacao'), true, 'Betim deve permitir instalação');

  await answer(channel, clientId, 'envio_retirada_cliente');
  assert.equal(Store.getSession(clientId).etapa, 'observacao_pedido_menu');

  await answer(channel, clientId, 'OBS_PEDIDO|SKIP');
  const completed = Store.getSession(clientId);
  assert.equal(completed.etapa, 'concluido');
  assert.equal(completed.completed, true);
  assert.equal(completed.dados.botDone, true);
  assert.equal(completed.dados.envio, 'Retirada');

  const note = events.find((event) => event.type === 'note');
  assert.ok(note, 'a conclusão deve salvar uma nota');
  assert.match(note.note, /Serviço: letreiro/);
  assert.match(note.note, /Cores: Preto/);
  assert.match(note.note, /Medida do letreiro: 100 x 50 cm/);
  assert.match(note.note, /Cidade: Betim\/MG/);
  assert.match(note.note, /Forma de recebimento: Retirada/);
  assert.match(events.at(-1)?.text || '', /Registrei todas as informações deste atendimento/i);
});

test('legado: fluxo de plotagem coleta descrição, medida, local e prazo', async () => {
  const clientId = '5531999990004@c.us';
  const { channel, events } = createRecordingChannel();

  await answer(channel, clientId, 'Oi');
  await answer(channel, clientId, 'serv_plotagem');
  await answer(channel, clientId, 'Plotagem para a vitrine');
  await answer(channel, clientId, '120x80 cm');
  await answer(channel, clientId, 'Vidro da fachada');
  await answer(channel, clientId, 'Até sexta-feira');

  const session = Store.getSession(clientId);
  assert.equal(session.completed, true);
  assert.equal(session.dados.flow, 'plotagem');
  assert.deepEqual(session.dados.demanda, {
    descricao: 'Plotagem para a vitrine',
    medida: '120x80 cm',
    local: 'Vidro da fachada',
    prazo: 'Até sexta-feira',
  });
  const note = events.find((event) => event.type === 'note');
  assert.match(note?.note || '', /Serviço: plotagem/);
  assert.match(note?.note || '', /Demanda: Plotagem para a vitrine/);
});

test('legado: fluxo de outros coleta descrição, referência e prazo', async () => {
  const clientId = '5531999990005@c.us';
  const { channel, events } = createRecordingChannel();

  await answer(channel, clientId, 'Oi');
  await answer(channel, clientId, 'serv_outros');
  await answer(channel, clientId, 'Preciso de uma placa em ACM');
  await answer(channel, clientId, 'Tenho foto e medida de 80x40');
  await answer(channel, clientId, 'Sem urgência');

  const session = Store.getSession(clientId);
  assert.equal(session.completed, true);
  assert.equal(session.dados.flow, 'outros');
  assert.deepEqual(session.dados.demanda, {
    descricao: 'Preciso de uma placa em ACM',
    referencia: 'Tenho foto e medida de 80x40',
    prazo: 'Sem urgência',
  });
  const note = events.find((event) => event.type === 'note');
  assert.match(note?.note || '', /Serviço: outros/);
  assert.match(note?.note || '', /Referência\/detalhes: Tenho foto e medida de 80x40/);
});

test('legado: etapa ativa é persistida em disco sem depender apenas da memória', async () => {
  const clientId = '5531999990006@c.us';
  const { channel } = createRecordingChannel();

  await answer(channel, clientId, 'Oi');
  await answer(channel, clientId, 'serv_letreiro');
  await answer(channel, clientId, 'acr_pintado');

  const current = Store.getSession(clientId);
  assert.equal(current.etapa, 'pantone');

  const persisted = JSON.parse(fs.readFileSync(path.join(sandboxRoot, 'data', 'sessions.json'), 'utf8'));
  const persistedSession = Object.values(persisted.sessions || {})
    .find((session) => session.chatId === clientId || session.contactIdentity?.primaryChatId === clientId);
  assert.ok(persistedSession, 'a sessão deve existir no arquivo persistido');
  assert.equal(persistedSession.etapa, 'pantone');
  assert.equal(persistedSession.dados.tipoAcrilico, 'pintado');
});

test('legado: atendimento concluído não reinicia enquanto a mesma sessão estiver válida', async () => {
  const clientId = '5531999990007@c.us';
  const { channel, events } = createRecordingChannel();

  await answer(channel, clientId, 'Oi');
  await answer(channel, clientId, 'serv_outros');
  await answer(channel, clientId, 'Uma placa');
  await answer(channel, clientId, 'Tenho uma referência');
  await answer(channel, clientId, 'Sem prazo');
  events.length = 0;

  await answer(channel, clientId, 'Oi novamente');

  assert.equal(Store.getSession(clientId).etapa, 'concluido');
  assert.match(events[0]?.text || '', /atendimento já foi registrado/i);
});

test.todo('segurança futura: mensagem manual fromMe precisa ativar handoff persistente');
test.todo('recuperação futura: resposta recebida com o sistema desligado precisa continuar da etapa persistida');
test.todo('segurança futura: histórico ou etiquetas inconclusivos precisam bloquear o envio automático');
