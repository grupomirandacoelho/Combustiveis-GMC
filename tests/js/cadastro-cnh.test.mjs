// Cadastro de motorista com cartões (27/11/2026, pedido do usuário: "Pede só a categoria da CNH no cadastro"): a Ticket recusa o
// motorista novo sem a categoria ("ds_categoria_carteira"); número e validade da CNH não são mais pedidos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PESSOAIS, PESSOAIS_CARTOES, validarPessoais } from '../../lib/cadastros.js';

test('da CNH só a categoria; obrigatória no motorista novo com cartões', () => {
  assert.deepEqual(PESSOAIS.map((c) => c.id), ['cpf', 'dataNascimento', 'cnhCategoria']);
  assert.deepEqual(PESSOAIS_CARTOES, ['cpf', 'dataNascimento', 'cnhCategoria']);
  const sem = validarPessoais({ cpf: '529.982.247-25', dataNascimento: '01/02/1980' }, PESSOAIS_CARTOES);
  assert.deepEqual(sem.erros, ['Informe a categoria da CNH.']);
  const com = validarPessoais({ cpf: '529.982.247-25', dataNascimento: '01/02/1980', cnhCategoria: 'E', cnh: '123', cnhValidade: '01/01/2030' }, PESSOAIS_CARTOES);
  assert.deepEqual(com.erros, []);
  assert.equal(com.pessoais.cnhCategoria, 'E');
  assert.ok(!('cnh' in com.pessoais) && !('cnhValidade' in com.pessoais), 'número e validade não são guardados');
  assert.equal(validarPessoais({ cpf: '529.982.247-25', dataNascimento: '01/02/1980', cnhCategoria: 'Z' }, PESSOAIS_CARTOES).erros.length, 1);
});

test('servidor e formulário exigem a categoria no novo com cartões', () => {
  assert.match(fs.readFileSync(new URL('../../functions/api/cadastros/[tipo].js', import.meta.url), 'utf8'), /cartoes \? PESSOAIS_CARTOES : \['cpf'\]/);
  assert.match(fs.readFileSync(new URL('../../public/gestao/paginas/cadastros.js', import.meta.url), 'utf8'), /cartoes \? \['cpf', 'dataNascimento', 'cnhCategoria'\]/);
});
