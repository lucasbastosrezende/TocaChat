import importlib
import os
import tempfile
import unittest


class ChatFeaturesTestCase(unittest.TestCase):
    _counter = iter(range(1, 10000))
    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.TemporaryDirectory()
        cls.db_path = os.path.join(cls.tmpdir.name, 'test_toca.db')
        os.environ['TOCACHAT_DB_PATH'] = cls.db_path

        import database
        import server

        cls.database = importlib.reload(database)
        cls.server_module = importlib.reload(server)
        cls.app = cls.server_module.app
        cls.app.config['TESTING'] = True

    @classmethod
    def tearDownClass(cls):
        cls.tmpdir.cleanup()
        os.environ.pop('TOCACHAT_DB_PATH', None)

    def setUp(self):
        self.client_a = self.app.test_client()
        self.client_b = self.app.test_client()
        suffix = next(self._counter)
        self.user_a = f'alice{suffix}'
        self.user_b = f'bob{suffix}'
        self._register(self.client_a, self.user_a)
        self._register(self.client_b, self.user_b)

    def _register(self, client, username):
        resp = client.post('/api/registro', json={'username': username, 'senha': '1234'})
        self.assertEqual(resp.status_code, 201)
        return resp.get_json()

    def _create_direct_chat(self):
        users = self.client_a.get('/api/usuarios').get_json()
        bob = next(u for u in users if u['username'] == self.user_b)
        resp = self.client_a.post('/api/conversas/direto', json={'usuario_id': bob['id']})
        self.assertIn(resp.status_code, (200, 201))
        return resp.get_json()

    def test_busca_mensagens_endpoint(self):
        conversa = self._create_direct_chat()
        conv_id = conversa['id']

        self.client_a.post(f'/api/conversas/{conv_id}/mensagens', json={'conteudo': 'primeira mensagem'})
        self.client_a.post(f'/api/conversas/{conv_id}/mensagens', json={'conteudo': 'agora tem banana aqui'})
        self.client_b.post(f'/api/conversas/{conv_id}/mensagens', json={'conteudo': 'outra coisa'})

        resp = self.client_a.get(f'/api/conversas/{conv_id}/mensagens/busca?q=banana')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data), 1)
        self.assertIn('banana', data[0]['conteudo'])

        short_resp = self.client_a.get(f'/api/conversas/{conv_id}/mensagens/busca?q=b')
        self.assertEqual(short_resp.status_code, 400)

    def test_reacoes_toggle_and_list(self):
        conversa = self._create_direct_chat()
        conv_id = conversa['id']

        msg_resp = self.client_a.post(f'/api/conversas/{conv_id}/mensagens', json={'conteudo': 'mensagem para reagir'})
        self.assertEqual(msg_resp.status_code, 201)
        msg_id = msg_resp.get_json()['id']

        react_resp = self.client_b.post(f'/api/mensagens/{msg_id}/reacoes', json={'emoji': '🔥'})
        self.assertEqual(react_resp.status_code, 200)
        self.assertEqual(react_resp.get_json()['action'], 'added')

        list_resp = self.client_a.get(f'/api/conversas/{conv_id}/mensagens')
        self.assertEqual(list_resp.status_code, 200)
        msgs = list_resp.get_json()
        target = next(m for m in msgs if m['id'] == msg_id)
        self.assertEqual(target['reacoes'][0]['emoji'], '🔥')
        self.assertEqual(target['reacoes'][0]['total'], 1)

        unreact_resp = self.client_b.post(f'/api/mensagens/{msg_id}/reacoes', json={'emoji': '🔥'})
        self.assertEqual(unreact_resp.status_code, 200)
        self.assertEqual(unreact_resp.get_json()['action'], 'removed')
        self.assertEqual(unreact_resp.get_json()['reacoes'], [])


if __name__ == '__main__':
    unittest.main()
