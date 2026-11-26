-- Aviso personalizado (26/11/2026; pedido do usuário: um tipo de aviso que ele monta, o primeiro sobre mudanças nos postos, enviado
-- a cada encarregado só com as unidades dele).
-- unidades do login (JSON com os códigos da lista oficial, ex.: ["JEQUIE","TEIXEIRA"]; NULL = todas): no aviso "separado por
-- unidade", a pessoa recebe só as ocorrências dessas unidades.
ALTER TABLE usuarios ADD COLUMN unidades TEXT;
-- o sino e a nuvem leem só as mudanças de postos recentes (últimas horas/dias): índice para não ler a tabela inteira a cada conferência
CREATE INDEX IF NOT EXISTS idx_alteracoes_postos_criado ON alteracoes_postos (criado_em);
