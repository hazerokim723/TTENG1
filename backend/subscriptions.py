"""Admin-only Toss sandbox subscriptions. Live charging is intentionally unsupported."""
from __future__ import annotations

import base64
import calendar
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timezone
from uuid import UUID, uuid4

import requests
from cryptography.fernet import Fernet
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .platform_store import admin, db, is_admin, rows, rpc, upsert, user

AMOUNT = 1000
TOSS_ORIGIN = 'https://api.tosspayments.com/v1'


def now():
    return datetime.now(timezone.utc)


def parse(value):
    return datetime.fromisoformat(value.replace('Z','+00:00'))


def next_month(current, anchor):
    month=current.month+1; year=current.year
    if month==13: year+=1; month=1
    return current.replace(year=year,month=month,day=min(anchor.day,calendar.monthrange(year,month)[1]),
                           hour=anchor.hour,minute=anchor.minute,second=anchor.second,microsecond=anchor.microsecond)


def settings():
    client=os.getenv('TOSS_CLIENT_KEY','').strip(); secret=os.getenv('TOSS_SECRET_KEY','').strip()
    encryption=os.getenv('BILLING_ENCRYPTION_KEY','').strip()
    if not client.startswith('test_ck_') or not secret.startswith('test_sk_') or not encryption:
        raise HTTPException(503,'관리자 테스트 결제 설정이 필요합니다. 테스트 키와 BILLING_ENCRYPTION_KEY를 설정해 주세요.')
    try: cipher=Fernet(encryption.encode())
    except (ValueError,TypeError): raise HTTPException(503,'빌링키 암호화 설정을 확인해 주세요.')
    return client,secret,cipher


def toss(path, method='GET', body=None, idempotency=None):
    _,secret,_=settings()
    headers={'Authorization':'Basic '+base64.b64encode((secret+':').encode()).decode(),'Content-Type':'application/json'}
    if idempotency: headers['Idempotency-Key']=idempotency
    try:
        result=requests.request(method,TOSS_ORIGIN+path,headers=headers,json=body,timeout=(5,30))
    except requests.RequestException as exc:
        raise HTTPException(504,'결제 결과를 확인 중입니다. 다시 청구하지 않고 결제 내역을 조회합니다.') from exc
    if not result.ok:
        try: code=result.json().get('code','')
        except ValueError: code=''
        if method=='GET' and result.status_code==404: return None
        raise HTTPException(502 if result.status_code>=500 else 400, f'토스 테스트 결제 처리 실패 ({code or result.status_code})')
    return result.json()


def verify_payment(payment, order):
    if payment.get('orderId')!=order['id'] or payment.get('totalAmount')!=order['amount'] or payment.get('currency')!='KRW':
        raise HTTPException(409,'서버 주문과 결제 결과가 일치하지 않습니다.')
    if payment.get('status')!='DONE':
        raise HTTPException(409,'결제 승인이 아직 완료되지 않았습니다.')


def revoke_payment(order):
    db('billing_orders','PATCH',params={'id':f'eq.{order["id"]}'},body={'status':'canceled'})
    db('subscription_periods','PATCH',params={'id':f'eq.{order["id"]}'},body={'revoked':True})
    db('subscriptions','PATCH',params={'id':f'eq.{order["subscription_id"]}'},body={'cancel_at_period_end':True})


def charge(subscription, start):
    """Stable order per billing cycle + lease + provider idempotency + DB fulfillment."""
    settings()
    token=str(uuid4()); lock='billing:'+subscription['id']
    if not rpc('platform_claim_lock',p_name=lock,p_token=token,p_seconds=120):
        raise HTTPException(409,'결제 결과를 확인 중입니다. 잠시 후 내역을 확인해 주세요.')
    try:
        current=rows('subscriptions',id=f'eq.{subscription["id"]}',limit='1')[0]
        if current['cancel_at_period_end'] or current['status']=='canceled':
            raise HTTPException(409,'해지된 구독입니다.')
        end=next_month(start,parse(current['anchor_at']) if current.get('anchor_at') else start)
        upsert('billing_orders',{'subscription_id':current['id'],'period_start':start.isoformat(),'period_end':end.isoformat(),'amount':AMOUNT},'subscription_id,period_start',ignore=True)
        order=rows('billing_orders',subscription_id=f'eq.{current["id"]}',period_start=f'eq.{start.isoformat()}',limit='1')[0]
        if order['status']=='paid': return order
        if order['status']=='canceled': raise HTTPException(409,'취소된 주문입니다.')
        # Unknown responses are always reconciled before attempting the same order.
        payment=toss('/payments/orders/'+order['id']) if order['status']!='pending' else None
        if not payment:
            db('billing_orders','PATCH',params={'id':f'eq.{order["id"]}'},body={'status':'processing'})
            _,_,cipher=settings()
            billing_key=cipher.decrypt(current['billing_key_encrypted'].encode()).decode()
            try:
                payment=toss('/billing/'+billing_key,'POST',{'customerKey':current['customer_key'],'amount':AMOUNT,
                    'orderId':order['id'],'orderName':'Turtle English 월 30개 — 테스트'},'cycle-'+order['id'])
            except HTTPException as exc:
                state='unknown' if exc.status_code>=500 else 'failed'
                db('billing_orders','PATCH',params={'id':f'eq.{order["id"]}'},body={'status':state,'error':exc.detail})
                if state=='failed': db('subscriptions','PATCH',params={'id':f'eq.{current["id"]}'},body={'status':'past_due'})
                raise
        if payment.get('orderId')==order['id'] and payment.get('status') in ('CANCELED','PARTIAL_CANCELED'):
            revoke_payment(order)
            return {'id':order['id'],'status':'canceled'}
        verify_payment(payment,order)
        rpc('billing_fulfill',p_order=order['id'],p_payment=payment['paymentKey'])
        return {'id':order['id'],'status':'paid'}
    finally:
        db('platform_locks','DELETE',params={'name':f'eq.{lock}','token':f'eq.{token}'})


def run_due():
    try: settings()
    except HTTPException: return {'enabled':False,'processed':0}
    count=0
    for sub in rows('subscriptions',status='eq.active',period_end=f'lte.{now().isoformat()}',order='period_end.asc',limit='1'):
        if not is_admin(sub['user_id']): continue
        if sub['cancel_at_period_end']:
            db('subscriptions','PATCH',params={'id':f'eq.{sub["id"]}'},body={'status':'canceled'})
            continue
        start = parse(sub['period_end']); anchor = parse(sub['anchor_at'])
        # Do not charge a backlog of months for a scheduler outage.
        while next_month(start,anchor) <= now(): start=next_month(start,anchor)
        try: charge(sub,start)
        except HTTPException: pass
        count+=1
    # First-charge or renewal response lost after Toss succeeded: recover without relying on a browser.
    for order in rows('billing_orders',status='in.(unknown,processing)',order='created_at.asc',limit='1'):
        sub=rows('subscriptions',id=f'eq.{order["subscription_id"]}',limit='1')[0]
        if is_admin(sub['user_id']):
            try: charge(sub,parse(order['period_start']))
            except HTTPException: pass
    return {'enabled':True,'processed':count}


class ConfirmRequest(BaseModel):
    auth_key: str = Field(min_length=1,max_length=300)
    customer_key: UUID
    state: str = Field(min_length=20,max_length=128)


def install_billing(app):
    router=APIRouter(prefix='/api/billing')

    @router.get('/status')
    def status(request:Request):
        uid=user(request)['id']; privileged=is_admin(uid)
        subs=rows('subscriptions',user_id=f'eq.{uid}',limit='1')
        sub=subs[0] if subs else None
        orders=rows('billing_orders',subscription_id=f'eq.{sub["id"]}',select='id,amount,status,period_start,period_end,created_at,error',order='created_at.desc',limit='20') if sub else []
        configured=True
        try: settings()
        except HTTPException: configured=False
        return {'test_only':True,'is_admin':privileged,'configured':configured,'amount':AMOUNT,'monthly_limit':30,
                'subscription':{k:sub[k] for k in ['status','period_start','period_end','cancel_at_period_end']} if sub else None,'orders':orders}

    @router.post('/setup')
    def setup(request:Request):
        uid=admin(request)['id']; client,_,_=settings()
        upsert('subscriptions',{'user_id':uid,'mode':'test'},'user_id,mode',ignore=True)
        sub=rows('subscriptions',user_id=f'eq.{uid}',mode='eq.test',limit='1')[0]
        if sub['status']=='active': raise HTTPException(409,'이미 활성화된 테스트 구독입니다.')
        # Never overwrite an unresolved billing key/order with a new signup.
        if rows('billing_orders',subscription_id=f'eq.{sub["id"]}',status='in.(processing,unknown)',limit='1'):
            raise HTTPException(409,'처리 중인 결제 내역을 먼저 확인해 주세요.')
        state=secrets.token_urlsafe(32)
        db('subscriptions','PATCH',params={'id':f'eq.{sub["id"]}'},body={'auth_state':hashlib.sha256(state.encode()).hexdigest()})
        return {'client_key':client,'customer_key':sub['customer_key'],'state':state,'amount':AMOUNT}

    @router.post('/confirm')
    def confirm(payload:ConfirmRequest,request:Request):
        uid=admin(request)['id']; _,_,cipher=settings()
        subs=rows('subscriptions',user_id=f'eq.{uid}',customer_key=f'eq.{payload.customer_key}',limit='1')
        if not subs: raise HTTPException(403,'결제 계정이 일치하지 않습니다.')
        sub=subs[0]
        if sub['status']=='active': return {'status':'active'}
        expected=sub.get('auth_state') or ''
        if not expected or not hmac.compare_digest(expected,hashlib.sha256(payload.state.encode()).hexdigest()):
            raise HTTPException(403,'카드 등록 요청이 만료되었습니다.')
        token=str(uuid4()); lock='billing-auth:'+sub['id']
        if not rpc('platform_claim_lock',p_name=lock,p_token=token,p_seconds=120): raise HTTPException(409,'카드 등록을 확인 중입니다.')
        try:
            current=rows('subscriptions',id=f'eq.{sub["id"]}',limit='1')[0]
            if current.get('auth_state')!=expected: raise HTTPException(409,'이미 처리된 카드 등록입니다. 결제 내역을 확인해 주세요.')
            issued=toss('/billing/authorizations/issue','POST',{'authKey':payload.auth_key,'customerKey':str(payload.customer_key)},'auth-'+hashlib.sha256(payload.auth_key.encode()).hexdigest()[:40])
            if issued.get('customerKey')!=str(payload.customer_key): raise HTTPException(409,'카드 등록 결과가 일치하지 않습니다.')
            anchor=now().replace(microsecond=0)
            db('subscriptions','PATCH',params={'id':f'eq.{sub["id"]}'},body={'billing_key_encrypted':cipher.encrypt(issued['billingKey'].encode()).decode(),
               'auth_state':None,'status':'incomplete','cancel_at_period_end':False,'anchor_at':anchor.isoformat(),'period_start':None,'period_end':None})
            current=rows('subscriptions',id=f'eq.{sub["id"]}',limit='1')[0]
            charge(current,anchor)
            return {'status':'active'}
        finally: db('platform_locks','DELETE',params={'name':f'eq.{lock}','token':f'eq.{token}'})

    @router.post('/retry')
    def retry(request:Request):
        uid=admin(request)['id']; subs=rows('subscriptions',user_id=f'eq.{uid}',limit='1')
        if not subs or not subs[0].get('billing_key_encrypted'): raise HTTPException(409,'먼저 테스트 카드를 등록해 주세요.')
        sub=subs[0]
        pending=rows('billing_orders',subscription_id=f'eq.{sub["id"]}',status='in.(pending,processing,unknown,failed)',order='period_start.asc',limit='1')
        if not pending: raise HTTPException(409,'재확인할 결제가 없습니다.')
        return charge(sub,parse(pending[0]['period_start']))

    @router.post('/cancel')
    def cancel(request:Request):
        uid=admin(request)['id']; subs=rows('subscriptions',user_id=f'eq.{uid}',limit='1')
        if not subs: raise HTTPException(404,'구독이 없습니다.')
        sub=subs[0]; token=str(uuid4()); lock='billing:'+sub['id']
        if not rpc('platform_claim_lock',p_name=lock,p_token=token,p_seconds=30): raise HTTPException(409,'결제 처리 중입니다. 잠시 후 해지해 주세요.')
        try:
            if rows('billing_orders',subscription_id=f'eq.{sub["id"]}',status='in.(processing,unknown)',limit='1'):
                raise HTTPException(409,'결제 결과를 먼저 재확인한 뒤 해지해 주세요.')
            db('subscriptions','PATCH',params={'id':f'eq.{sub["id"]}'},body={'cancel_at_period_end':True})
            return {'cancel_at_period_end':True}
        finally: db('platform_locks','DELETE',params={'name':f'eq.{lock}','token':f'eq.{token}'})

    @router.post('/webhook')
    def webhook(payload:dict):
        data=payload.get('data') or {}; key=data.get('paymentKey')
        if not isinstance(key,str) or len(key)>200: return {'received':True}
        orders=rows('billing_orders',payment_key=f'eq.{key}',limit='1')
        if not orders: return {'received':True}
        if not rpc('platform_claim_lock',p_name='webhook:'+hashlib.sha256(key.encode()).hexdigest(),p_token=str(uuid4()),p_seconds=10):
            return {'received':True}
        payment=toss('/payments/'+key)
        order=orders[0]
        if payment and payment.get('orderId')==order['id'] and payment.get('status') in ('CANCELED','PARTIAL_CANCELED'):
            revoke_payment(order)
        return {'received':True}

    app.include_router(router)
