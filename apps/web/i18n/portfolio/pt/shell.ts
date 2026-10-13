import type { Shell } from '../en/shell';

// The frame of the portfolio section in Brazilian Portuguese: the same keys as en/shell.ts.

export const shell: Shell = {
  head: 'Seu portfólio',
  notAdvice: 'Aviso legal',
  menu: {
    region: 'Páginas do portfólio',
    nav: 'Portfólio',
    show: 'Mostrar menu',
    hide: 'Esconder menu',
  },
  reading: 'Lendo seus planos…',
  signedOut:
    'Entre para ver seus planos ao longo do tempo. Cada um fica em um cofre na rede da sua carteira, e só você pode sacar dele.',
  empty:
    'Você ainda não tem plano em um cofre. Um cofre é criado quando você compra seu primeiro plano.',
  startGoal: 'Comece pelo seu objetivo',
  again: 'Ler de novo',
  againBusy: 'Lendo…',
  failure: {
    unavailable:
      'Este servidor ainda não guarda o histórico dos seus planos, então não há nada para mostrar aqui. Não vou mostrar números inventados no lugar.',
    signedOut:
      'Nosso servidor não reconhece mais seu login, então não consigo ler seus planos. Saia e entre de novo.',
    noIdentity:
      'Ainda não consigo ler seus planos: o serviço de login não me deu a parte do seu login que lista suas carteiras. Espere um minuto e tente de novo.',
    throwaway:
      'A carteira descartável não tem conta no nosso servidor, então não há planos dela para ler.',
    unreachable: 'Não consegui falar com nosso servidor para ler seus planos. Tente de novo.',
    unreadable:
      'Nosso servidor respondeu com algo que não consegui ler, então não vou mostrar. Tente de novo.',
    refused: 'Nosso servidor não aceitou esse pedido, então não há nada para mostrar dele.',
  },
  soon: 'Esta página ainda não foi construída, então não há nada para ler aqui por enquanto.',
};
