"""Rotina dos painéis só quando muda (migração 20261125235000, 25/11/2026): todas as tabelas que os geradores dos arquivos leem
precisam somar o contador por gatilho; senão uma mudança nelas só apareceria na conferência diária."""
import glob
import os
import re
import unittest

MIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'supabase', 'migrations')
GERADORES = ('gestao_gerar_dados_painel', 'gestao_gerar_base_copia', 'gestao_gerar_consolidacao', 'gestao_assinatura_painel',
             'gestao_assinatura_base')
PROPRIAS = {'public.dados_painel', 'public.dados_gerados', 'public.dados_motoristas'}   # onde os geradores gravam


def ultima_definicao(sql_por_arquivo, nome):
    corpo = None
    for sql in sql_por_arquivo:
        for m in re.finditer(r'create or replace function public\.' + nome + r'\(.*?\$\$(.*?)\$\$', sql, re.S | re.I):
            corpo = m.group(1)
    return corpo


class GatilhosDoPainel(unittest.TestCase):
    def test_toda_tabela_lida_pelos_geradores_tem_gatilho(self):
        arquivos = sorted(glob.glob(os.path.join(MIG, '*.sql')))
        sqls = [open(a, encoding='utf-8').read() for a in arquivos]
        lidas = set()
        for nome in GERADORES:
            corpo = ultima_definicao(sqls, nome)
            self.assertIsNotNone(corpo, nome)
            lidas |= {t.lower() for t in re.findall(r'(?:from|join)\s+((?:public|gestao)\.[a-z_]+)', corpo, re.I)}
        lidas -= PROPRIAS
        gatilho = open(os.path.join(MIG, '20261125235000_painel_so_quando_muda.sql'), encoding='utf-8').read()
        com_gatilho = {t.lower() for t in re.findall(r'create trigger painel_mudou .*? on ((?:public|gestao)\.[a-z_]+)', gatilho, re.I)}
        self.assertTrue(lidas, 'nenhuma tabela encontrada')
        self.assertEqual(lidas - com_gatilho, set())

    def test_agendamento_chama_so_a_rotina_leve(self):
        gatilho = open(os.path.join(MIG, '20261125235000_painel_so_quando_muda.sql'), encoding='utf-8').read()
        self.assertIn("cron.schedule('gestao-dados-painel', '*/2 * * * *', $cron$select public.gestao_dados_painel_rodar()$cron$)", gatilho)


if __name__ == '__main__':
    unittest.main()
