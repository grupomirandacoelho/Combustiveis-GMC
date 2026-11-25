-- 25/11/2026: o portal voltou a responder 500 em 24/11 das 16:16 às 21:00 (limite diário de 5 milhões de linhas lidas do D1).
-- Depois do índice da 0029 o maior leitor era a limpeza dos dados pessoais (cadastros/pendentes, chamada pelo vigia a cada 10 s:
-- 2.063 vezes x 762 linhas) e as consultas dos cadastros nos cartões (vigia e nuvem a cada 5 min), que liam a tabela inteira.
-- Índices parciais: só as linhas que ainda têm dados pessoais (poucas; somem em 7 dias).
CREATE INDEX IF NOT EXISTS idx_alt_cadastros_pessoais ON alteracoes_cadastros (criado_em) WHERE pessoais IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alt_cadastros_pessoais_id ON alteracoes_cadastros (tipo, acao, id) WHERE pessoais IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alt_cadastros_aplicada ON alteracoes_cadastros (tipo, estado, aplicada_em);
