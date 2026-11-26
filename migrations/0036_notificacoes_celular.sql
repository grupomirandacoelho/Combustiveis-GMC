-- Notificações no celular (26/11/2026; pedido do usuário: começar pela equipe de gestão, escolher em cada notificação se vai para o
-- celular). celular = 1: além do sino, a nuvem (Edge Function notificacoes-push) manda para os aparelhos de quem recebe a regra.
ALTER TABLE notificacoes ADD COLUMN celular INTEGER NOT NULL DEFAULT 0;

-- aparelhos que ativaram as notificações (inscrição Web Push do navegador). Não vai para o espelho do Supabase (como as sessões):
-- p256dh/auth são as chaves do aparelho. Sai sozinha quando o serviço de push diz que a inscrição acabou (404/410).
CREATE TABLE push_inscricoes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id),
  endpoint      TEXT NOT NULL UNIQUE,              -- endereço do serviço de push do navegador (Google, Apple, Mozilla, Microsoft)
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  aparelho      TEXT,                              -- descrição curta (ex.: "iPhone", "Android · Chrome") para o usuário reconhecer
  criado_em     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ultimo_envio  TEXT
);
CREATE INDEX idx_push_inscricoes_usuario ON push_inscricoes (usuario_id);
