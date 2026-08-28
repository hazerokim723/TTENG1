import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import (
    LearningItem,
    TranslationItem,
    app,
    fetch_caption_entries_from_supadata,
    normalize_items,
)


class TurtleEnglishApiTests(unittest.TestCase):
    def setUp(self) -> None:
        app.state.translation_cache.clear()
        self.client = TestClient(app)

    def test_expression_range_is_repaired_against_rendered_sentence(self) -> None:
        sentence = "We need to come up with a better plan."
        item = LearningItem(
            timestamp_sec=4.2,
            timestamp_display="",
            full_sentence_original=sentence,
            masked_sentence=sentence,
            target_word="come up with",
            expression="come up with",
            expression_type="phrasal_verb",
            word_type="phrasal verb",
            definition_kr="생각해 내다",
            hint_for_tap="",
            sentence_index=3,
            start_char=0,
            end_char=4,
        )

        normalized = normalize_items([item])[0]

        self.assertEqual(normalized.start_char, sentence.index("come up with"))
        self.assertEqual(normalized.end_char, normalized.start_char + len("come up with"))
        self.assertEqual(normalized.anchor_words, ["come", "up", "with"])
        self.assertTrue(normalized.is_phrasal_verb)

    def test_translation_cache_works_without_browser_supabase_credentials(self) -> None:
        with patch.dict(os.environ, {"SUPABASE_URL": "", "SUPABASE_SERVICE_ROLE_KEY": ""}):
            response = self.client.post(
                "/api/translations/cache",
                json={
                    "video_id": "ELI8AwyXF1Q",
                    "transcript_hash": "hash12345678",
                    "translation_version": "test-v1",
                    "total_sentences": 2,
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["translations"], [])
        self.assertFalse(response.json()["persistent"])

    def test_batch_translation_is_cached_and_reused(self) -> None:
        translated = [TranslationItem(sentence_index=0, translation_kr="자연스러운 번역입니다.")]
        payload = {
            "video_id": "ELI8AwyXF1Q",
            "transcript_hash": "hash12345678",
            "translation_version": "test-v1",
            "total_sentences": 1,
            "title": "Test episode",
            "channel_name": "Test channel",
            "topic": "Test topic",
            "sentences": [{"sentence_index": 0, "text": "A natural translation."}],
        }
        env = {
            "OPENAI_API_KEY": "test-key",
            "SUPABASE_URL": "",
            "SUPABASE_SERVICE_ROLE_KEY": "",
        }
        with patch.dict(os.environ, env), patch("backend.main.translate_sentences", return_value=translated) as translate:
            first = self.client.post("/api/translations/batch", json=payload)
            second = self.client.post("/api/translations/batch", json=payload)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json()["translations"][0]["translation_kr"], "자연스러운 번역입니다.")
        translate.assert_called_once()

    def test_lookup_accepts_only_one_sentence(self) -> None:
        response = self.client.post(
            "/api/translations/lookup",
            json={
                "video_id": "ELI8AwyXF1Q",
                "transcript_hash": "hash12345678",
                "translation_version": "test-v1",
                "total_sentences": 2,
                "sentences": [
                    {"sentence_index": 0, "text": "First."},
                    {"sentence_index": 1, "text": "Second."},
                ],
            },
        )

        self.assertEqual(response.status_code, 400)

    def test_supadata_uses_server_key_and_native_caption_mode(self) -> None:
        response_payload = {
            "content": [
                {"text": "First caption", "offset": 1500, "duration": 900},
                {"text": "Second caption", "offset": 2600, "duration": 800},
            ],
            "lang": "en",
        }

        with patch("backend.main.requests.get") as get:
            get.return_value.status_code = 200
            get.return_value.json.return_value = response_payload
            entries = fetch_caption_entries_from_supadata("ELI8AwyXF1Q", "server-secret")

        self.assertEqual(entries, [(1.5, "First caption"), (2.6, "Second caption")])
        _, kwargs = get.call_args
        self.assertEqual(kwargs["headers"]["x-api-key"], "server-secret")
        self.assertEqual(kwargs["params"]["mode"], "native")
        self.assertEqual(kwargs["params"]["lang"], "en")


if __name__ == "__main__":
    unittest.main()
