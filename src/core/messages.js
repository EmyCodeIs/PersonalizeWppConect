'use strict';

function welcome(name) {
  return name
    ? `Olá, ${name}! 👋\nBem-vindo(a) ao Canal de Atendimento da Personalize!`
    : 'Olá! 👋\nBem-vindo(a) ao Canal de Atendimento da Personalize!';
}

const messages = {
  welcome,
  askService: '🔸\nQual dos nossos serviços deseja?',

  // Plotagem e Outros são pré-atendimentos curtos. A primeira mensagem abaixo
  // é a única enviada ao selecionar a opção; depois da descrição do cliente,
  // o bot registra a demanda e deixa a conversa não lida para o vendedor.
  plotagem: 'Nos explique sua demanda para plotagens. Caso tenha fotos ou vídeos de referência, encaminhe por aqui para agilizar o atendimento.',
  otherService: 'Nos explique qual produto ou serviço você precisa. Caso tenha fotos ou vídeos de referência, encaminhe por aqui para agilizar o atendimento.',
  askPlotagemDescricao: 'Nos explique sua demanda para plotagens. Caso tenha fotos ou vídeos de referência, encaminhe por aqui para agilizar o atendimento.',
  askPlotagemMedida: 'Você já tem a medida aproximada?\n\nPode mandar em cm ou metro. Exemplo: 120x80 cm, 2x1m, ou “ainda não tenho medida”.',
  askPlotagemLocal: 'Onde será aplicada a plotagem?\n\nExemplos: vidro, parede, ACM, carro, porta, fachada, balcão etc.',
  askPlotagemPrazo: 'Tem algum prazo ou data que precisa ficar pronto?',
  askOtherDescricao: 'Nos explique qual produto ou serviço você precisa. Caso tenha fotos ou vídeos de referência, encaminhe por aqui para agilizar o atendimento.',
  askOtherReferencia: 'Você tem alguma medida, foto, referência ou detalhe importante? Pode mandar por texto mesmo.',
  askOtherPrazo: 'Tem algum prazo ou urgência para esse pedido?',

  completedContactNote: 'Pronto! Registrei todas as informações deste atendimento na sua ficha de contato. 😊',
  mostruario: 'Confira nosso mostruário de *Letreiros e Cores* e veja alguns modelos para te inspirar!\n\nIrei dar início ao seu orçamento logo abaixo:',
  mostruarioLink: '🔗 Ver Mostruário',
  askAcrylicType: 'Selecione o tipo de acrílico do seu letreiro:',
  askColorCount: 'Quantas cores terá seu letreiro?',
  askPantone: '🎨 *Cor Personalizada*\n\nMe informe a *cor Pantone* (código da sua cor).\n\nPode também enviar sua paleta de cores ou o arquivo da sua *logo/identidade visual* para referência.',
  askMeasure: '📏\n*Me diga, qual será a largura e altura do seu letreiro?*\n(em centímetros)\n\nPor exemplo:\n\n* Para letreiro acima de uma porta: 80-120cm de largura x 20-30cm de altura\n* Para parede grande: 150cm ou mais de largura\n\n⚠️ Se não souber a altura exata, pode informar só a largura que usaremos uma altura proporcional à arte.',
  askMeasureDescription: 'Tudo bem! Me descreva o tamanho aproximado (ex.: tamanho de uma folha A4, acima de uma porta, para uma parede grande) que usaremos como referência.',
  invalidMeasure: 'Não consegui identificar a medida. Você pode enviar assim: 100x20 (em cm), ou descrever um tamanho (ex.: tamanho de uma folha A4).',
  askArtQuestion: '🖼️ \nAgora preciso da arte do seu letreiro:',
  askArtExplanation: '*Se você já tem sua arte em:*\n *PDF*, *AI* preciso que me envie para a criação do *Letreiro*.\n Caso não tenha, aceitamos print de referência, ou você pode apenas descrever sua ideia pra gente.',
  askArtFree: '📂 \nVocê pode enviar por aqui o arquivo, uma imagem de referência ou apenas descrever sua ideia.',
  askArtFile: 'Perfeito! Envie o arquivo da arte por aqui. Você também pode mandar observações em mensagens separadas.',
  askArtImage: 'Perfeito! Envie a imagem de referência por aqui e, se precisar, escreva os detalhes em outras mensagens.',
  askArtDescription: 'Perfeito! Descreva como imagina o letreiro. Pode mandar em várias mensagens que vou juntar tudo.',
  askCity: '📍\nPara finalizarmos, me diga sua *cidade e estado*.\nEx.: Belo Horizonte/MG',
  askAddress: 'Qual seu endereço completo?\n(Rua/Av + número, Bairro, CEP e Complemento, se houver)',
  pickupAddress: 'Combinado! Você poderá retirar na empresa.\n\n📍 Nós estamos localizados na Rua Selênio 226, Bairro Prado.',
  installationNote: 'Para instalação, a equipe precisa analisar o endereço e os detalhes informados antes da confirmação final.',
  askObservation: '📝\nGostaria de anexar alguma informação sobre o letreiro? Pode ser quantidade, detalhe de logo, observação de instalação, acabamento ou qualquer ponto importante.',
  askObservationText: 'Claro! Me conte o que gostaria de acrescentar ao pedido.',
  fallback: 'Não consegui entender direitinho. Vou reenviar a etapa atual para você escolher novamente.',
};

module.exports = { messages };
