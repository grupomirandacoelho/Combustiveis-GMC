// Identidade de uma transação para juntar a base com o tempo real das APIs dos cartões sem contar duas vezes (19/11/2026):
// placa (só letras e números) | minuto | litros × 100 — a mesma do chaveTransacao do scripts/cartoes_api.mjs e da função do banco
// gestao_chaves_tempo_real. dia = dias desde 1970-01-01; seg = segundos desde a meia-noite (hora local, como em todo o portal).
// Usada pelos painéis (lib/dados.js) e pela área do motorista (functions/api/motorista/dados.js).
export function chaveLinha(placa, dia, seg, litros) {
  return String(placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '') + '|' + (Number(dia) * 1440 + Math.floor((Number(seg) || 0) / 60)) +
    '|' + Math.round(Number(litros || 0) * 100);
}
