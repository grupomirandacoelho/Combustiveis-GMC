// /postos.csv — lista dos motoristas. Vem do Workers KV (publicada pelo vigia a partir da planilha de negociações) ou, com a chave
// KV "postos-fonte" = "banco", do banco (lib/postos-fonte.js; 15.3, 25/11/2026); enquanto não houver nada, cai no arquivo
// estático public/postos.csv.
import { lerPostos } from '../lib/postos-fonte.js';

export async function onRequestGet({ env, next }) {
  const l = await lerPostos(env);
  if (!l) return next();
  return new Response('﻿' + l.csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
