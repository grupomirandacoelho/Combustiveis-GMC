// 27/11/2026 (pedido do usuário: "Em várias partes do site tem escrito coisa sobre o base_copia e a base, ajusta isso para mim"):
// com o vigia desligado, nenhum texto da tela fala em Base_copia, no vigia ou no computador da sincronização, e o aviso
// "Base desatualizada" saiu dos tipos de notificação.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const raiz = new URL('../../', import.meta.url);
const STR = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;
// tira os comentários (// e /* */) antes de procurar nos textos
const semComentarios = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
function arquivos(dir) {
  const out = [];
  for (const e of fs.readdirSync(new URL(dir, raiz), { withFileTypes: true })) {
    const p = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...arquivos(p + '/'));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('textos da tela sem Base_copia, vigia ou computador da sincronização', () => {
  const ruins = [];
  for (const a of [...arquivos('public/gestao/'), ...arquivos('functions/')]) {
    if (a.includes('/sync/')) continue;   // rotas da sincronização (nomes de tabela, não texto de tela)
    for (const s of semComentarios(fs.readFileSync(new URL(a, raiz), 'utf8')).match(STR) || []) {
      if (/[a-zà-ú]{3,} [a-zà-ú]{2,}/.test(s) && /Base_copia|computador da sincroniza|\bo vigia\b|pelo vigia|aguardando o vigia/.test(s)) ruins.push(a + ': ' + s.slice(0, 100));
    }
  }
  assert.deepEqual(ruins, []);
});

test('aviso "Base desatualizada" fora dos tipos de notificação', async () => {
  const { TIPOS } = await import('../../public/gestao/lib/notificacao.js');
  assert.ok(!('base-desatualizada' in TIPOS));
  assert.doesNotMatch(fs.readFileSync(new URL('functions/api/notificacoes/index.js', raiz), 'utf8'), /'base-desatualizada':/);
});
