"""Comparação diária planilhas de cadastro x banco (scripts/comparar_cadastros.py, virada de 25/11/2026). Dados fictícios."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'scripts'))
try:
    import comparar_cadastros as C  # noqa: E402
except ImportError:  # pragma: no cover
    C = None


@unittest.skipIf(C is None, 'dependências das planilhas não instaladas')
class Diferencas(unittest.TestCase):
    def test_iguais_com_numero_inteiro_e_linha_diferente(self):
        a = [{'linha': 2, 'placa': 'AAA1A11', 'meta': 3, 'situacao': 'ATIVA'}]
        b = [{'linha': 9, 'placa': 'AAA1A11', 'meta': 3.0, 'situacao': 'ATIVA'}]
        self.assertEqual(C.diferencas('placas', a, b, 'placa'), [])

    def test_formula_da_planilha_sem_valor_nao_conta(self):
        a = [{'placa': 'AAA1A11', 'autonomia': None, 'pontoCritico': 0}]
        b = [{'placa': 'AAA1A11', 'autonomia': 701.25, 'pontoCritico': 2.9}]
        self.assertEqual(C.diferencas('placas', a, b, 'placa'), [])

    def test_diferenca_e_falta_e_senha_sem_valor_no_relatorio(self):
        a = [{'usuario': '000001', 'nome': 'A', 'senhaTicket': '1111'}, {'usuario': '000002', 'nome': 'B'}]
        b = [{'usuario': '000001', 'nome': 'A2', 'senhaTicket': '2222'}]
        d = C.diferencas('motoristas', a, b, 'usuario')
        self.assertIn({'lista': 'motoristas', 'chave': '000001', 'campo': 'nome', 'planilha': 'A', 'banco': 'A2'}, d)
        self.assertIn({'lista': 'motoristas', 'chave': '000001', 'campo': 'senhaTicket'}, d)
        self.assertIn({'lista': 'motoristas', 'chave': '000002', 'so_na': 'planilha'}, d)
        self.assertNotIn('1111', repr(d))
        self.assertNotIn('2222', repr(d))

    def test_precos_da_bomba_por_dia_fornecedor_e_repeticao(self):
        n = {'dic': {'fornecedor': ['A'], 'produto': ['ARLA'], 'unidade': ['SP', 'BA']},
             'col': {'data': [1, 1, 1], 'fornecedor': [0, 0, 0], 'produto': [0, 0, 0], 'unidade': [0, 0, 1], 'preco': [3.1, 3.2, 3.0]}}
        self.assertEqual(C.precos(n), [{'chave': '1|A|ARLA|SP|1', 'preco': 3.1}, {'chave': '1|A|ARLA|SP|2', 'preco': 3.2},
                                       {'chave': '1|A|ARLA|BA|1', 'preco': 3.0}])
        self.assertEqual(C.precos(None), [])


if __name__ == '__main__':
    unittest.main()
