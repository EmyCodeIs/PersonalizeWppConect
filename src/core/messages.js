'use strict';

function welcome(name) {
  return name
    ? `Olá, ${name}! 👋\nBem-vindo(a) ao Canal de Atendimento da Personalize!`
    : 'Olá! 👋\nBem-vindo(a) ao Canal de Atendimento da Personalize!';
}

const messages = {
  welcome,
  askService: '🔸\nQual dos nossos serviço deseja?\n\n* Letreiro de acrílico\n* Plotagem\n* Outros',
  askFlow: 'Para eu te atender melhor, seu orçamento é para *letreiro em acrílico*?\n\n1️⃣ Sim, quero letreiro\n2️⃣ Não, é outro serviço',
  nonLettering: 'Entendi! Vou salvar seus dados para um vendedor continuar seu atendimento.',
  plotagem: 'Entendi! Vou salvar seu atendimento de *Plotagem* para um vendedor continuar por aqui.',
  otherService: 'Entendi! Vou salvar seu atendimento para um vendedor continuar por aqui.',
  mostruario: 'Confira nosso mostruário de *Letreiros e Cores* e veja alguns modelos para te inspirar!\n\nIrei dar início ao seu orçamento logo abaixo:',
  mostruarioLink: '🔗 Ver Mostruário',
  askAcrylicType: 'Selecione o tipo de acrílico do seu letreiro:',
  askColorCount: 'Quantas cores terá seu letreiro?\n\n1️⃣ 1 cor\n2️⃣ 2 cores\n3️⃣ 3 cores\n4️⃣ 4 cores\n5️⃣ 5 cores',
  askSolidColors: 'Me informe as cores do seu letreiro.\n\nCores sólidas: preto, branco, cinza, azul, verde, vermelho, amarelo, roxo, rosa.\nEspelhadas: dourado, prata, rose, vermelho, verde, azul.\n\nPode responder separando por vírgula.',
  askPantone: 'Me envie a cor personalizada/Pantone desejada. Pode mandar o código, descrição ou anexo de referência.',
  fixed3mm: '🔎 Observação: cores sólidas possuem espessura padrão de 3mm.',
  askDepth: 'Deseja seguir com 3mm ou adicionar acrílico cristal por trás?\n\n1️⃣ Seguir com 3mm\n2️⃣ +3mm\n3️⃣ +6mm\n4️⃣ +10mm',
  askPersonalizedThickness: 'Qual espessura deseja para o acrílico personalizado?\n\n1️⃣ 4mm\n2️⃣ 6mm\n3️⃣ 10mm',
  askArt: '🖼️ Agora preciso da arte do seu letreiro:\n\n1️⃣ Tenho arquivo (PDF/AI/EPS/SVG)\n2️⃣ Enviar imagem de referência\n3️⃣ Descrever ideia',
  askArtFree: '📂 Pode enviar por aqui o arquivo, uma imagem de referência ou apenas descrever sua ideia.',
  askMeasure: '📏 *Me diga, qual será a largura e altura do seu letreiro?*\n(em centímetros)\n\nExemplos:\n• 80x30\n• 120x25\n• só 100 de largura, se não souber a altura\n\n⚠️ Se não souber a altura exata, pode informar só a largura que usaremos uma altura proporcional à arte.',
  invalidMeasure: 'Não consegui identificar a medida. Você pode enviar assim: 100x20 (em cm), ou descrever um tamanho (ex.: tamanho de uma folha A4).',
  askCity: 'Qual cidade e estado para calcularmos envio/retirada/instalação?',
  askDelivery: 'Como deseja receber?\n\n1️⃣ Correios / transportadora\n2️⃣ Instalação (BH e região)\n3️⃣ Retirada',
  askAddress: 'Me envie o endereço completo para seguirmos com essa opção.',
  pickupAddress: 'A retirada é na Rua Selênio 226, Bairro Prado. Vou encaminhar seu orçamento para conferência.',
  installationNote: 'Para instalação, o orçamento precisa ser alinhado com vendedor antes do pagamento. Vou registrar essa opção.',
  forwardQuote: 'Encaminhei seu orçamento! Só mais alguns instantes e já te retorno.',
  fallback: 'Não consegui entender direitinho. Pode responder com uma das opções ou escrever de outro jeito?',
};

module.exports = { messages };
