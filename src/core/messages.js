'use strict';

function welcome(name, options = {}) {
  const isReturning = !!options.isReturning;
  if (isReturning) {
    return name
      ? `Olá, ${name}! 👋\nQue bom te ver novamente no Canal de Atendimento da Personalize!`
      : 'Olá! 👋\nQue bom te ver novamente no Canal de Atendimento da Personalize!';
  }

  return name
    ? `Olá, ${name}! 👋\nBem-vindo(a) ao Canal de Atendimento da Personalize!`
    : 'Olá! 👋\nBem-vindo(a) ao Canal de Atendimento da Personalize!';
}

const messages = {
  welcome,
  askService: '🔸\nQual dos nossos serviços deseja?',
  plotagem: 'Perfeito! Vou coletar algumas informações rápidas para registrar sua solicitação completa.',
  otherService: 'Perfeito! Vou coletar algumas informações rápidas para registrar sua solicitação completa.',
  askPlotagemDescricao: 'Me conta rapidinho: qual tipo de plotagem você precisa?\n\nExemplos: vitrine, parede, veículo, placa, adesivo, envelopamento etc. Você também pode enviar uma imagem de referência.',
  askPlotagemMedida: 'Você já tem a medida aproximada?\n\nPode mandar em cm ou metro. Exemplo: 120x80 cm, 2x1m, ou “ainda não tenho medida”.',
  askPlotagemLocal: 'Onde será aplicada a plotagem?\n\nExemplos: vidro, parede, ACM, carro, porta, fachada, balcão etc.',
  askPlotagemPrazo: 'Tem algum prazo ou data que precisa ficar pronto?',
  askOtherDescricao: 'Me conta qual serviço ou produto você precisa. Você também pode enviar uma imagem ou arquivo de referência.',
  askOtherReferencia: 'Você tem alguma medida, foto, referência ou detalhe importante? Pode enviar por texto ou como anexo.',
  askOtherPrazo: 'Tem algum prazo ou urgência para esse pedido?',
  completedContactNote: 'Certo! Encaminhei seu pedido para nossos vendedores e, em breve, alguém da equipe continuará o atendimento por aqui. 😊\n\nSe quiser acrescentar alguma informação ou tiver alguma dúvida, fique à vontade para enviar uma mensagem.',
  supportAsk: 'Certo, me explique sua demanda para que eu encaminhe ao nosso suporte.',
  supportForwarded: 'Certo, encaminhei sua mensagem para nossa equipe que em breve assumirá o atendimento. Aguarde por aqui. 🙂',
  supportNeedDetails: 'Pode me explicar o que aconteceu ou qual ajuda você precisa? Você também pode enviar imagem ou arquivo.',
  mostruario: 'Confira nosso mostruário de *Letreiros e Cores* e veja alguns modelos para te inspirar!\n\nIrei dar início ao seu orçamento logo abaixo:',
  mostruarioLink: '🔗 Ver Mostruário',
  askAcrylicType: 'Selecione o tipo de acrílico do seu letreiro:',
  askColorCount: 'Quantas cores terá seu letreiro?',
  askPantone: '🎨 *Cor Personalizada*\n\nMe informe a *cor Pantone* (código da sua cor).\n\nPode também enviar sua paleta de cores ou o arquivo da sua *logo/identidade visual* para referência.',
  askMeasure: '📏 *Me diga, qual será a largura e altura do seu letreiro?*\n(em centímetros)\n\nExemplos:\n• 80x30\n• 120x25\n• só 100 de largura, se não souber a altura\n\n⚠️ Se não souber a altura exata, pode informar só a largura que usaremos uma altura proporcional à arte.',
  askMeasureDescription: 'Sem problemas! Me descreva o tamanho que você imagina.\nEx.: tamanho de uma folha A4, para uma porta, ou proporcional a uma parede.',
  invalidMeasure: 'Não consegui identificar a medida. Você pode enviar assim: *100x20* (em cm), informar apenas a largura/altura, ou descrever um tamanho (ex.: tamanho de uma folha A4).',
  askArtQuestion: '🖼️ Agora preciso da arte do seu letreiro.',
  askArtExplanation: 'Você pode enviar um arquivo em PDF/AI/EPS/SVG, uma imagem de referência ou apenas descrever sua ideia.',
  askArtFree: '📂 Pode enviar tudo em mensagens separadas. Vou juntar as informações antes de continuar.',
  askArtFile: 'Perfeito! Envie o arquivo da arte por aqui. Você também pode mandar observações em mensagens separadas.',
  askArtImage: 'Perfeito! Envie a imagem de referência por aqui e, se precisar, escreva os detalhes em outras mensagens.',
  askArtDescription: 'Perfeito! Descreva como imagina o letreiro. Pode mandar em várias mensagens que vou juntar tudo.',
  askCity: '📍\nPara finalizarmos, me diga sua *cidade e estado*.\nEx.: Belo Horizonte/MG',
  askAddress: 'Qual seu endereço completo?\n(Rua/Av + número, Bairro, CEP e Complemento, se houver)',
  pickupAddress: 'Combinado! Você poderá retirar na empresa.\n\n📍 Nós estamos localizados na Rua Selênio 226, Bairro Prado.',
  installationNote: 'Para instalação, a equipe precisa analisar o endereço e os detalhes informados antes da confirmação final.',
  askObservation: '📝\nGostaria de anexar alguma informação sobre o letreiro? Pode ser quantidade, detalhe de logo, observação de instalação, acabamento ou qualquer ponto importante.',
  askObservationText: 'Perfeito! Me envie a observação em uma ou mais mensagens. Quando você parar por alguns segundos, vou juntar tudo e finalizar o cadastro.',
  askGeneralObservation: '📝\nGostaria de acrescentar alguma observação ou detalhe importante sobre o pedido?',
  askGeneralObservationText: 'Perfeito! Pode enviar a observação em uma ou mais mensagens. Vou juntar tudo antes de finalizar.',
  fallback: 'Não consegui entender direitinho. Vou reenviar a etapa atual para você escolher novamente.',
};

module.exports = { messages };
