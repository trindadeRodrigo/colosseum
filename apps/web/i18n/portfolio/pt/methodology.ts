import type { TrackLine } from '@colosseum/schemas';
import type { Methodology } from '../en/methodology';

// How the portfolio section reads a person's plans, in Brazilian Portuguese: the same keys as
// en/methodology.ts. "Retrato" (snapshot), "margem" (band) and "orçamento de perdas" (loss budget) are
// proposals: Rodrigo owns this wording. A tier is "faixa", as on the plan screen.

const lines: Record<TrackLine, string> = {
  verdict:
    'Nosso motor entregou um veredito sobre o seu objetivo. Ele vale mais que todas as linhas abaixo, e a situação passa a citar a regra do motor. Nada entrega um veredito ainda.',
  never_read: 'O cofre ainda não tem retrato.',
  empty: 'O cofre não guarda nada. Um depósito conta quando a rede mostra o cofre com ele.',
  chain_silent: 'Faz um dia ou mais que a rede foi lida pela última vez.',
  loss_half:
    'As perdas do nosso operador usaram metade ou mais do orçamento de perdas. É nesta linha que nosso operador dispara um alerta.',
  unpriced:
    'Uma parte que está no cofre e no plano não tem preço, então o plano não pode ser pesado.',
  no_band: 'A rede não define margem, então não há com o que comparar as partes.',
  outside_band:
    'Uma parte está mais longe da fatia planejada do que a margem. Exatamente na margem conta como dentro.',
  cash_over:
    'O caixa está acima da fatia dele por mais do que a margem. Caixa abaixo da fatia não é uma linha própria.',
  loss_quarter: 'As perdas do nosso operador usaram um quarto ou mais do orçamento de perdas.',
  stale: 'O retrato mais recente tem mais de uma hora.',
  inside:
    'Nenhuma das linhas acima vale. A parte do orçamento de perdas já usada é dita ao lado da situação.',
  inside_no_budget:
    'Nenhuma das linhas acima vale, em uma rede que não mantém orçamento de perdas. Uma rede assim pula as duas linhas de perdas.',
};

export const methodology: Methodology = {
  label: 'Metodologia',
  title: 'Como estas páginas leem seus planos.',
  lead: 'O que é um retrato, o que cada situação quer dizer, de onde vem cada número e o que estas páginas ainda não sabem dizer.',
  snapshot: {
    heading: 'O que é um retrato',
    body: [
      'Um retrato é uma leitura de um cofre, guardada inteira: o que ele tinha, quanto valia cada parte, a fatia dela e a fatia planejada, e todo preço em que os valores se apoiaram. Cada preço guarda sua fonte, sua hora e seu método.',
      'Lemos cada cofre que conhecemos mais ou menos a cada dez minutos, da própria rede dele, e guardamos cada leitura. Um cofre criado fora deste app é encontrado em até uma hora.',
      'O leitor não tem chave nenhuma. Ele lê e guarda: não assina, não negocia e não move nada.',
      'Por enquanto ele lê só redes de teste e a nossa rede de exemplo. Todo número aqui leva essa marca, e nenhum é mostrado como real.',
      'Um retrato com mais de uma hora é chamado de desatualizado, com a idade dele ao lado.',
    ],
  },
  status: {
    heading: 'O que cada situação quer dizer',
    intro: (rule: string) =>
      `A situação de um plano vem do nosso servidor. Ela é calculada a partir do retrato mais recente do cofre do plano por uma regra fixa, chamada ${rule}, e aparece com a linha da regra que a deu.`,
    notForecast: 'A regra não estima nada. Ela lê o que o retrato guardou, e não é uma previsão.',
    means: {
      on_track:
        'Nenhuma das linhas abaixo vale: toda parte e o caixa estão dentro da margem, as perdas do nosso operador estão abaixo de um quarto do orçamento de perdas, e o retrato mais recente não tem mais de uma hora.',
      watch:
        'Uma parte está fora da margem, ou o caixa está acima da fatia dele por mais do que a margem, ou uma parte que está no cofre e no plano não tem preço, ou as perdas do nosso operador usaram um quarto ou mais do orçamento de perdas, ou o retrato mais recente tem mais de uma hora.',
      off_track:
        'As perdas do nosso operador usaram metade ou mais do orçamento de perdas, ou a rede não é lida há um dia ou mais.',
      none: 'Ainda não há com o que comparar o cofre: ele não foi lido, não guarda nada, ou a rede dele não define margem.',
    },
    goal: 'A situação diz como um cofre está em relação ao plano dele e aos limites da rede. Ela ainda não diz se o valor ou a data do seu objetivo serão atingidos: esse veredito é do nosso motor, e ele ainda não está conectado.',
    terms: [
      [
        'Margem',
        'quanto uma parte pode ficar longe da fatia planejada antes de contar como fora. É uma configuração da rede, guardada com cada retrato.',
      ],
      [
        'Orçamento de perdas',
        'o máximo que nosso operador pode perder de um cofre em uma semana quando rebalanceia. Também é uma configuração da rede, guardada com cada retrato.',
      ],
    ],
    order: 'As linhas da regra, na ordem em que são testadas',
    first: 'A primeira linha que vale dá a situação.',
    asVerdict: 'A situação do próprio veredito',
    lines,
  },
  sources: {
    heading: 'De onde vem cada número',
    items: [
      [
        'O valor de um cofre',
        'o retrato mais recente do cofre: o que ele tinha como o leitor da rede informou, cada parte ao preço guardado com o retrato, e o caixa a um dólar.',
      ],
      [
        'O total de uma rede',
        'os valores no retrato mais recente de cada um dos seus cofres naquela rede, somados. Cofres em redes diferentes são contados, nunca somados entre si.',
      ],
      [
        'O que você colocou',
        'o caixa de cada compra sua por este app cujo depósito foi confirmado, contado uma vez por ordem. É o valor bruto: um saque não é descontado, e dinheiro que chegou ao cofre por outro caminho não está nele.',
      ],
      [
        'A situação',
        'a leitura que nosso servidor faz do retrato mais recente pela regra acima, com a linha que a deu e o nome da regra.',
      ],
      [
        'Um valor ao longo do tempo',
        'um ponto para cada passo do período mostrado: o último retrato tirado naquele passo.',
      ],
      [
        'Um rebalanceamento',
        'um passo seu vem do que este app guardou das suas ordens, com a cotação com que ele foi montado pela última vez. Uma operação do nosso operador é deduzida de dois retratos entre os quais a rede mostra que ele negociou um ativo.',
      ],
      [
        'Exposição',
        'o que o retrato mais recente de cada cofre tinha, somado pelo que cada ativo acompanha e por quem o emite, rede por rede.',
      ],
      [
        'Um custo de venda',
        'o custo, medido pela Bearing, de vender toda a sua posição em um ativo em uma rede. Onde a Bearing não mede o ativo, a faixa dele é citada como alternativa, e uma faixa não informa custo.',
      ],
    ],
    pin: 'Todo número leva sua fonte, sua hora e seu método: abra a marca ao lado dele para ler.',
  },
  cannot: {
    heading: 'O que estas páginas ainda não sabem dizer',
    items: [
      'Quando um passo seu foi confirmado na rede. A hora ao lado de um passo é a de quando ele foi montado: nada guarda o momento da confirmação.',
      'Quanto uma operação pagou. O custo ao lado de um passo é o da cotação com que ele foi montado, e pode aparecer como zero onde não havia preço de referência.',
      'As operações do nosso operador, uma por uma. O diário dele não está nos nossos dados, então cada linha dele é deduzida dos retratos, sem id da transação, sem cotação e sem motivo. Várias operações de um ativo entre dois retratos aparecem como uma só.',
      'Uma versão de um portfólio compartilhado que nosso operador adotou para você.',
      'Seus próprios rebalanceamentos, saques e mudanças de configuração. Essas ordens ainda não existem, então seus passos aqui são compras e versões que você aceitou manualmente.',
      'O que você tirou. O que você colocou é o valor bruto, e a hora de um depósito é a de quando nosso servidor soube dele.',
      'O custo de vender tudo de uma vez. Cada custo de venda é o de um ativo vendido sozinho.',
      'De quais pools, ou de qual hora da semana, um custo de venda veio.',
      'Um custo de venda entre redes: cada um é medido em uma rede.',
      'Emissores e faixas reais na nossa rede de exemplo: todo emissor ali é um substituto.',
    ],
  },
  boundary:
    'Estas páginas mostram o que foi lido e como foi calculado. Elas não dizem o que você deve fazer: o aviso abaixo vale para tudo isso.',
};
