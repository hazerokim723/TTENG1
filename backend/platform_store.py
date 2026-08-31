"""Server-only Supabase access; failures never silently fall back to free access."""
from __future__ import annotations

import os
from typing import Any
from uuid import UUID

import requests
from fastapi import HTTPException, Request


def config() -> tuple[str, str]:
    url = (os.getenv('SUPABASE_URL', '').strip() or os.getenv('VITE_SUPABASE_URL', '').strip()).rstrip('/')
    key = os.getenv('SUPABASE_SERVICE_ROLE_KEY', '').strip()
    if not url or not key:
        missing = ', '.join(name for name, value in [('SUPABASE_URL', url), ('SUPABASE_SERVICE_ROLE_KEY', key)] if not value)
        raise HTTPException(503, f'서버 학습 저장소 설정이 필요합니다. Vercel Production에 {missing}를 등록한 뒤 다시 배포해 주세요.')
    return url, key


def db(path: str, method: str = 'GET', *, params: dict | None = None,
       body: Any = None, prefer: str = '') -> Any:
    url, key = config()
    headers = {'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}
    if prefer:
        headers['Prefer'] = prefer
    try:
        result = requests.request(method, f'{url}/rest/v1/{path}', headers=headers,
                                  params=params, json=body, timeout=(5, 25))
    except requests.RequestException as exc:
        raise HTTPException(503, '학습 저장소 연결이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.') from exc
    if not result.ok:
        if 'TRIAL_LIMIT' in result.text:
            raise HTTPException(402, '무료 AI 학습 10회를 모두 사용했습니다. 기존 영상은 계속 복습할 수 있어요.')
        if 'MONTHLY_LIMIT' in result.text:
            raise HTTPException(402, '이번 이용 기간의 새 영상 30개를 모두 사용했습니다.')
        raise HTTPException(503, '학습 저장소 요청에 실패했습니다. 관리자에게 문의해 주세요.')
    return result.json() if result.content else None


def rpc(name: str, **kwargs):
    return db(f'rpc/{name}', 'POST', body=kwargs)


def rows(table: str, **filters) -> list[dict]:
    return db(table, params={k: v for k, v in filters.items() if v is not None}) or []


def upsert(table: str, body, conflict: str, ignore: bool = False):
    return db(table, 'POST', params={'on_conflict': conflict}, body=body,
              prefer=f'resolution={"ignore" if ignore else "merge"}-duplicates,return=representation')


def user(request: Request) -> dict:
    authorization = request.headers.get('authorization', '')
    if not authorization.startswith('Bearer '):
        raise HTTPException(401, 'AI 학습을 시작하려면 Google로 로그인해 주세요.')
    url, key = config()
    try:
        response = requests.get(f'{url}/auth/v1/user', headers={'apikey': key, 'Authorization': authorization}, timeout=(5, 15))
    except requests.RequestException as exc:
        raise HTTPException(503, '로그인 확인이 지연되고 있습니다.') from exc
    if not response.ok:
        raise HTTPException(401, '로그인이 만료되었습니다. 다시 로그인해 주세요.')
    result = response.json()
    try:
        UUID(result['id'])
    except (ValueError, KeyError):
        raise HTTPException(401, '유효하지 않은 로그인입니다.')
    if result.get('is_anonymous'):
        raise HTTPException(401, 'Google 계정으로 로그인해 주세요.')
    return result


def is_admin(uid: str) -> bool:
    return bool(rows('platform_admins', user_id=f'eq.{uid}', limit='1'))


def admin(request: Request) -> dict:
    result = user(request)
    if not is_admin(result['id']):
        raise HTTPException(403, '관리자만 사용할 수 있습니다.')
    return result
