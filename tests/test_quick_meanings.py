import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.main import app
from backend.quick_definitions import QuickMeaning, QuickMeanings, quick_meanings, sentence_words

AID = 'a' * 64
UID = '47274e07-9a50-4a78-a33d-f4e8cfeaf267'
ARTIFACT = {'id': AID, 'video_id': 'ELI8AwyXF1Q', 'transcript': [{'text': 'A river bank.'}]}


class QuickMeaningTests(unittest.TestCase):
    def test_word_batch_is_bounded_and_offsets_match(self):
        text = 'A bank, a bank. ' + ' '.join('word' + chr(65 + i) for i in range(26))
        words = sentence_words(text)
        self.assertEqual(len(words), 24)
        self.assertEqual(sum(w.casefold() == 'bank' for w, _ in words), 1)
        for word, offset in words:
            self.assertEqual(text[offset:offset + len(word)], word)

    def test_compact_response_preserves_context_and_rejects_invented_expressions(self):
        parsed = QuickMeanings(definitions=[
            QuickMeaning(lookup_word='bank', word='bank', word_type='noun', definition_kr='강둑', expression_type='vocabulary'),
            QuickMeaning(lookup_word='river', word='made up phrase', word_type='noun', definition_kr='틀린 뜻', expression_type='idiom'),
        ])
        client = MagicMock()
        client.responses.parse.return_value = SimpleNamespace(output_parsed=parsed)
        with patch('backend.quick_definitions.OpenAI', return_value=client):
            result = quick_meanings([('river', 2), ('bank', 8)], 'A river bank.', 'gpt-5-mini', 'fake')
        self.assertEqual(result['bank']['definition_kr'], '강둑')
        self.assertNotIn('river', result)
        self.assertNotIn('example_en', result['bank'])
        self.assertEqual(client.responses.parse.call_args.kwargs['model'], 'gpt-5-mini')

    def test_phrasal_verb_still_resolves_from_any_member(self):
        for word, offset in [('come', 0), ('up', 5), ('with', 8)]:
            value = QuickMeaning(lookup_word=word, word='come up with', word_type='verb', definition_kr='생각해 내다', expression_type='phrasal_verb')
            client = MagicMock()
            client.responses.parse.return_value = SimpleNamespace(output_parsed=QuickMeanings(definitions=[value]))
            with patch('backend.quick_definitions.OpenAI', return_value=client):
                result = quick_meanings([(word, offset)], 'come up with a plan', 'gpt-5-mini', 'fake')
            self.assertEqual(result[word]['word'], 'come up with')


class LookupAndAdminTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.service = app.state.platform

    def test_prefetch_requires_login(self):
        self.assertEqual(self.client.post('/api/learning/definitions', json={'artifact_id': AID, 'sentence_index': 0}).status_code, 401)

    def test_admin_start_never_reserves_or_consumes_trial(self):
        with patch('backend.learning_platform.user', return_value={'id': UID}), patch('backend.learning_platform.is_admin', return_value=True), patch('backend.learning_platform.rows', return_value=[]), patch('backend.learning_platform.db'), patch('backend.learning_platform.upsert'), patch('backend.learning_platform.rpc') as rpc, patch.object(self.service, 'ensure_artifact', return_value=ARTIFACT), patch.object(self.service, 'snapshot', return_value={'title': 'Test', 'source_name': 'Channel', 'duration_sec': 30}):
            response = self.client.post('/api/learning/start', json={'youtube_url': ARTIFACT['video_id']})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['usage']['plan'], 'admin')
        self.assertIsNone(response.json()['usage']['remaining'])
        rpc.assert_not_called()

    def test_claimed_admin_email_without_db_role_still_obeys_limit(self):
        with patch('backend.learning_platform.user', return_value={'id': UID, 'email': 'hazerokim723@gmail.com'}), patch('backend.learning_platform.is_admin', return_value=False), patch('backend.learning_platform.rpc', side_effect=HTTPException(402, 'TRIAL_LIMIT')) as rpc:
            response = self.client.post('/api/learning/start', json={'youtube_url': ARTIFACT['video_id']})
        self.assertEqual(response.status_code, 402)
        rpc.assert_called_once_with('learning_reserve', p_user=UID, p_video=ARTIFACT['video_id'])

    def test_ready_sentence_cache_never_calls_ai(self):
        definitions = [{'word_key': word.casefold(), 'definition': {'word': word, 'word_type': 'noun', 'definition_kr': '짧은 뜻'}} for word, _ in sentence_words(ARTIFACT['transcript'][0]['text'])]
        with patch('backend.learning_platform.user', return_value={'id': UID}), patch.object(self.service, 'artifact', return_value=ARTIFACT), patch.object(self.service, 'access', return_value={'state': 'granted'}), patch('backend.learning_platform.rows', return_value=definitions), patch('backend.learning_platform.quick_meanings') as ai:
            response = self.client.post('/api/learning/definitions', json={'artifact_id': AID, 'sentence_index': 0})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()['definitions']), 3)
        ai.assert_not_called()

    def test_prefetch_cannot_bypass_artifact_access(self):
        with patch('backend.learning_platform.user', return_value={'id': UID}), patch.object(self.service, 'artifact', return_value=ARTIFACT), patch.object(self.service, 'access', side_effect=HTTPException(403, 'Forbidden')), patch('backend.learning_platform.quick_meanings') as ai:
            response = self.client.post('/api/learning/definitions', json={'artifact_id': AID, 'sentence_index': 0})
        self.assertEqual(response.status_code, 403)
        ai.assert_not_called()

    def test_prefetch_generates_only_missing_words_and_saves_for_reuse(self):
        cached = [{'word_key': 'bank', 'definition': {'word': 'bank', 'definition_kr': '강둑'}}]
        generated = {'river': {'word': 'river', 'word_type': 'noun', 'definition_kr': '강', 'expression_type': 'vocabulary'}}
        with patch('backend.learning_platform.user', return_value={'id': UID}), patch.object(self.service, 'artifact', return_value=ARTIFACT), patch.object(self.service, 'access', return_value={'state': 'granted'}), patch('backend.learning_platform.rows', return_value=cached), patch('backend.learning_platform.rpc', return_value=True), patch('backend.learning_platform.db') as db, patch('backend.learning_platform.upsert') as save, patch('backend.learning_platform.quick_meanings', return_value=generated) as ai:
            response = self.client.post('/api/learning/definitions', json={'artifact_id': AID, 'sentence_index': 0})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(('bank', 8), ai.call_args.args[0])
        self.assertEqual(save.call_args.args[0], 'context_definitions')
        self.assertEqual(save.call_args.args[1][0]['sentence_index'], 0)
        self.assertEqual(save.call_args.args[1][0]['artifact_id'], AID)
        db.assert_called_once()
        self.assertEqual(db.call_args.args[:2], ('platform_locks', 'DELETE'))

    def test_admin_preparation_failure_does_not_touch_trial_allowance(self):
        with patch('backend.learning_platform.user', return_value={'id': UID}), patch('backend.learning_platform.is_admin', return_value=True), patch('backend.learning_platform.rows', return_value=[]), patch('backend.learning_platform.rpc') as rpc, patch.object(self.service, 'ensure_artifact', side_effect=HTTPException(502, 'Caption failure')):
            response = self.client.post('/api/learning/start', json={'youtube_url': ARTIFACT['video_id']})
        self.assertEqual(response.status_code, 502)
        rpc.assert_not_called()


if __name__ == '__main__':
    unittest.main()
