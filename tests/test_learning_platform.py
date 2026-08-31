import os
import unittest
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from cryptography.fernet import Fernet
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.main import app, TranslationItem, TranslationBatchRequest
from backend.learning_platform import Platform
from backend.subscriptions import next_month, settings, verify_payment, charge, AMOUNT
from backend.platform_store import config

AID = 'a' * 64
VID = 'ELI8AwyXF1Q'
UID = str(uuid4())


class AccessBoundaryTests(unittest.TestCase):
    def setUp(self): self.client = TestClient(app)

    def test_public_url_is_reused_but_never_public_key(self):
        with patch.dict(os.environ,{'SUPABASE_URL':'','VITE_SUPABASE_URL':'https://example.supabase.co','SUPABASE_SERVICE_ROLE_KEY':'','VITE_SUPABASE_PUBLISHABLE_KEY':'public'}):
            with self.assertRaises(HTTPException) as error: config()
            self.assertIn('SUPABASE_SERVICE_ROLE_KEY',error.exception.detail)
        with patch.dict(os.environ,{'SUPABASE_URL':'','VITE_SUPABASE_URL':'https://example.supabase.co','SUPABASE_SERVICE_ROLE_KEY':'server-test'}):
            self.assertEqual(config(),('https://example.supabase.co','server-test'))

    def test_no_token_never_reaches_paid_services(self):
        requests = [('/api/learning/start', {'youtube_url': VID}),
                    ('/api/learning/work', {'artifact_id': AID}),
                    ('/api/learning/lookup', {'artifact_id': AID, 'word': 'bank', 'sentence_index': 0, 'clicked_offset': 0}),
                    ('/api/admin/library', {'youtube_url': VID}),
                    ('/api/admin/library/prepare', {'youtube_url': VID}),
                    ('/api/billing/setup', {}), ('/api/billing/cancel', {})]
        with patch('backend.learning_platform.rpc') as rpc:
            for path, payload in requests:
                with self.subTest(path=path): self.assertEqual(self.client.post(path, json=payload).status_code, 401)
            rpc.assert_not_called()

    def test_normal_user_cannot_call_admin_routes(self):
        with patch('backend.platform_store.user', return_value={'id': UID}), patch('backend.platform_store.is_admin', return_value=False):
            for path in ['/api/admin/library', '/api/admin/library/prepare', '/api/billing/setup']:
                self.assertEqual(self.client.post(path, json={'youtube_url': VID}).status_code, 403)

    def test_invalid_worker_secret_rejected(self):
        with patch.dict(os.environ, {'INTERNAL_WORKER_SECRET': 'test-secret'}):
            for path in ['/api/internal/tick', '/api/internal/billing-tick']:
                self.assertEqual(self.client.post(path, headers={'x-worker-secret': 'wrong'}).status_code, 403)

    def test_artifact_version_cannot_be_substituted(self):
        service = Platform(MagicMock())
        with patch('backend.learning_platform.is_admin', return_value=False), patch('backend.learning_platform.rows', return_value=[{'state': 'granted', 'artifact_id': 'b'*64}]):
            with self.assertRaises(HTTPException) as error: service.access(UID, {'id': AID, 'video_id': VID})
        self.assertEqual(error.exception.status_code, 403)

    def test_expired_reservation_cannot_generate(self):
        access={'state':'reserved','artifact_id':AID,'reservation_until':(datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()}
        with patch('backend.learning_platform.is_admin',return_value=False),patch('backend.learning_platform.rows',return_value=[access]):
            with self.assertRaises(HTTPException) as error: Platform(MagicMock()).access(UID,{'id':AID,'video_id':VID})
        self.assertEqual(error.exception.status_code,409)

    def test_existing_video_can_finish_after_subscription_expires(self):
        self.assertTrue(Platform(MagicMock()).can_generate(UID, {'id':AID}, {'state':'granted','source':'subscription'}))

    def test_work_accepts_only_server_artifact_not_user_text(self):
        self.assertEqual(self.client.post('/api/learning/work',json={'artifact_id':'unknown','transcript':'free prompt'}).status_code,422)


class SharedArtifactTests(unittest.TestCase):
    def setUp(self):
        self.engine=MagicMock()
        self.engine.ANALYSIS_VERSION='a1'; self.engine.TRANSLATION_VERSION='t1'
        self.engine.TranslationItem=TranslationItem; self.engine.TranslationBatchRequest=TranslationBatchRequest
        self.service=Platform(self.engine)
        self.artifact={'id':AID,'video_id':VID,'transcript_hash':'12345678','analysis_version':'a1','translation_version':'t1',
                       'transcript':[{'text':'The river bank.','timestamp_sec':0,'end_sec':3,'timestamp_display':'00:00'}]}

    def test_ready_shared_artifact_never_refetches_captions(self):
        with patch('backend.learning_platform.rows',return_value=[{'active_artifact_id':AID}]),patch.object(self.service,'artifact',return_value=self.artifact):
            self.assertEqual(self.service.ensure_artifact(VID),self.artifact)
        self.engine.fetch_caption_entries.assert_not_called()

    def test_completed_chunk_does_not_call_openai(self):
        with patch('backend.learning_platform.rpc',return_value=None): self.service.process(self.artifact,'analysis',0)
        self.engine.analyze_chunk.assert_not_called()

    def test_translation_cache_reused_without_generation(self):
        chunk={'chunk_index':0,'first_sentence':0,'last_sentence':1}
        def read(table,**filters):
            if table=='library_episodes': return [{'title':'River','channel_name':'Test'}]
            if table=='episode_translations':
                self.assertEqual(filters['transcript_hash'],'eq.12345678')
                self.assertEqual(filters['translation_version'],'eq.t1')
                return [{'sentence_index':0,'translation_kr':'강둑.'}]
            return []
        with patch.dict(os.environ,{'OPENAI_API_KEY':'fake'}),patch('backend.learning_platform.rpc',return_value=chunk),patch('backend.learning_platform.rows',side_effect=read),patch('backend.learning_platform.db') as db:
            self.service.process(self.artifact,'translation',0)
        self.engine.translate_sentences.assert_not_called()
        self.assertEqual(db.call_args.kwargs['body']['result'][0]['translation_kr'],'강둑.')

    def test_long_chunk_list_is_not_truncated_at_supabase_row_limit(self):
        with patch('backend.learning_platform.rows',side_effect=[[{}]*500,[{}]*500,[{}]]) as read:
            self.assertEqual(len(self.service.chunks(AID)),1001)
            self.assertEqual(read.call_args.kwargs['offset'],'1000')


class SandboxBillingTests(unittest.TestCase):
    def test_live_keys_are_rejected(self):
        with patch.dict(os.environ,{'TOSS_CLIENT_KEY':'live_ck_x','TOSS_SECRET_KEY':'live_sk_x','BILLING_ENCRYPTION_KEY':Fernet.generate_key().decode()}):
            with self.assertRaises(HTTPException): settings()

    def test_month_end_returns_to_original_anchor(self):
        jan=datetime(2026,1,31,12,tzinfo=timezone.utc)
        feb=next_month(jan,jan); march=next_month(feb,jan)
        self.assertEqual((feb.month,feb.day),(2,28)); self.assertEqual((march.month,march.day),(3,31))

    def test_leap_year_and_year_rollover(self):
        jan=datetime(2028,1,31,tzinfo=timezone.utc)
        self.assertEqual(next_month(jan,jan).day,29)
        dec=datetime(2026,12,31,tzinfo=timezone.utc)
        self.assertEqual(next_month(dec,dec).year,2027)

    def test_provider_amount_and_status_verified(self):
        order={'id':'order','amount':1000}
        for changes in [{'totalAmount':1},{'orderId':'other'},{'currency':'USD'},{'status':'READY'}]:
            with self.subTest(changes=changes),self.assertRaises(HTTPException):
                verify_payment({'orderId':'order','totalAmount':1000,'currency':'KRW','status':'DONE',**changes},order)

    def test_unknown_success_is_queried_before_any_charge(self):
        start=datetime.now(timezone.utc)
        sub={'id':str(uuid4()),'user_id':UID,'cancel_at_period_end':False,'status':'incomplete','anchor_at':start.isoformat()}
        order={'id':str(uuid4()),'status':'unknown','amount':AMOUNT}
        payment={'orderId':order['id'],'totalAmount':AMOUNT,'currency':'KRW','status':'DONE','paymentKey':'test-payment'}
        with patch('backend.subscriptions.settings'),patch('backend.subscriptions.rpc',return_value=True) as rpc,patch('backend.subscriptions.rows',side_effect=[[sub],[order]]),patch('backend.subscriptions.db'),patch('backend.subscriptions.upsert'),patch('backend.subscriptions.toss',return_value=payment) as toss:
            self.assertEqual(charge(sub,start)['status'],'paid')
        toss.assert_called_once_with('/payments/orders/'+order['id'])
        self.assertEqual(rpc.call_args.args[0],'billing_fulfill')

    def test_paid_order_is_not_charged_again(self):
        start=datetime.now(timezone.utc)
        sub={'id':str(uuid4()),'cancel_at_period_end':False,'status':'active','anchor_at':start.isoformat()}
        with patch('backend.subscriptions.settings'),patch('backend.subscriptions.rpc',return_value=True),patch('backend.subscriptions.rows',side_effect=[[sub],[{'status':'paid'}]]),patch('backend.subscriptions.db'),patch('backend.subscriptions.upsert'),patch('backend.subscriptions.toss') as toss:
            self.assertEqual(charge(sub,start)['status'],'paid')
        toss.assert_not_called()


if __name__=='__main__': unittest.main()
