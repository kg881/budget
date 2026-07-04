#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Бюджет — Telegram-дайджест и напоминания.

Читает data.json (тот же файл, что ведёт веб-приложение), считает статус
текущего бюджетного месяца, бонусный пул и прогресс по целям, и шлёт
короткий дайджест в Telegram. Плюс контекстные напоминания:
  • около 5-го числа — впиши факт дохода (зп приходит 5-го за прошлый месяц);
  • в конце месяца — пора «закрыть месяц» в приложении.

Зависимостей нет — только стандартная библиотека (urllib).

Настройка (см. scripts/README.md):
  export TG_BOT_TOKEN="123456:AA..."
  export TG_CHAT_ID="123456789"
  # либо положи их в ~/.claude/secrets/budget_tg.env как KEY=VALUE

Запуск:
  python3 tg_digest.py                 # шлёт дайджест
  python3 tg_digest.py --dry           # печатает в консоль, не шлёт
  python3 tg_digest.py --data /path/to/data.json
"""

import os
import sys
import json
import argparse
import datetime
import urllib.request
import urllib.parse
import html as _html

M_CAP = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август',
         'Сентябрь','Октябрь','Ноябрь','Декабрь']
M_ROD = ['января','февраля','марта','апреля','мая','июня','июля','августа',
         'сентября','октября','ноября','декабря']

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DATA = os.path.normpath(os.path.join(HERE, '..', 'data.json'))
SECRETS = os.path.expanduser('~/.claude/secrets/budget_tg.env')


# ---------- helpers ----------
def load_secrets():
    """Подхватывает TG_* из окружения или из ~/.claude/secrets/budget_tg.env."""
    if os.path.exists(SECRETS):
        with open(SECRETS, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def ym_today():
    d = datetime.date.today()
    return '%04d-%02d' % (d.year, d.month)


def ym_add(ym, n):
    y, m = map(int, ym.split('-'))
    m += n
    y += (m - 1) // 12
    m = (m - 1) % 12 + 1
    return '%04d-%02d' % (y, m)


def ym_diff(a, b):
    ya, ma = map(int, a.split('-'))
    yb, mb = map(int, b.split('-'))
    return (yb - ya) * 12 + (mb - ma)


def midx(ym):
    return int(ym.split('-')[1]) - 1


def rub(n):
    try:
        return '{:,.0f}'.format(round(n)).replace(',', ' ')
    except Exception:
        return '—'


def signed(n):
    s = '+' if n > 0 else ('−' if n < 0 else '')
    return s + rub(abs(n))


# ---------- расчёты (зеркалят логику приложения) ----------
def month_totals(st, ym):
    s = st.get('settings') or {}
    m = st.get('months', {}).get(ym)
    ip = s.get('incomePlan', 0) or 0
    if not m:
        # месяц ещё не трогали — в приложении он наследует шаблон расходов
        tpl = (st.get('template') or {}).get('expenses') or []
        ep = sum((t.get('amount') or 0) for t in tpl)
        return dict(ip=ip, if_=None, ep=ep, ef=0, open=ep,
                    closed=0, cats=len(tpl), dfact=None, locked=False)
    exps = m.get('expenses', [])
    ep = sum((e.get('plan') or 0) for e in exps)
    closed = [e for e in exps if e.get('closed')]
    ef = sum(((e.get('fact') if e.get('fact') is not None else e.get('plan')) or 0)
             for e in closed)
    open_sum = sum((e.get('plan') or 0) for e in exps if not e.get('closed'))
    iff = m.get('incomeFact')
    has = iff is not None or len(closed) > 0
    dfact = ((iff if iff is not None else ip) - ef) if has else None
    return dict(ip=ip, if_=iff, ep=ep, ef=ef, open=open_sum,
                closed=len(closed), cats=len(exps), dfact=dfact,
                locked=bool(m.get('locked')))


def pool_in(st):
    rate = (st.get('settings') or {}).get('planRate', 78) or 78
    inn = 0.0
    for b in st.get('bonuses', []):
        if b.get('rub') is not None:
            inn += b['rub']
        elif b.get('usd') is not None:
            inn += b['usd'] * (b.get('rate') or rate)
    return inn


def pool_total(st):
    """Всё, что заведено в пул и ещё не потрачено на купленные цели."""
    spent = sum((g.get('spent') or 0) for g in st.get('goals', []) if g.get('done'))
    return pool_in(st) - spent


def pool_free(st):
    """Свободно к распределению = всего в пуле − уже разложено по активным целям."""
    allocated = sum((g.get('saved') or 0) for g in st.get('goals', []) if not g.get('done'))
    return pool_total(st) - allocated


def active_goals(st):
    """Активные цели с их отложенной суммой (g.saved), в порядке отображения."""
    active = sorted([g for g in st.get('goals', []) if not g.get('done')],
                    key=lambda g: (g.get('priority', 99), g.get('targetMonth', '')))
    return [(g, g.get('saved') or 0) for g in active]


def bonus_stats(st):
    ov = st.get('bonusOverrides', {}) or {}
    hist = []
    for x in st.get('bonusHistory', []):
        v = ov.get(x['month'], x.get('usd'))
        if v is not None and v > 0:
            hist.append(v)
    if not hist:
        return None
    hist_sorted = sorted(hist)
    mean = sum(hist) / len(hist)
    n = len(hist_sorted)
    median = (hist_sorted[n // 2] if n % 2 else
              (hist_sorted[n // 2 - 1] + hist_sorted[n // 2]) / 2)
    return dict(n=n, mean=mean, median=median, mx=max(hist))


# ---------- дайджест ----------
def build_digest(st):
    today = datetime.date.today()
    ym = ym_today()
    s = st.get('settings') or {}
    rate = s.get('planRate', 78) or 78
    t = month_totals(st, ym)
    L = []

    L.append('<b>Бюджет · %s %s</b>' % (M_CAP[midx(ym)], ym.split('-')[0]))
    L.append('')

    # текущий месяц
    inc = t['if_'] if t['if_'] is not None else t['ip']
    inc_tag = 'факт' if t['if_'] is not None else 'план'
    L.append('<b>Месяц</b>')
    L.append('• доход: %s ₽ (%s), план %s ₽' % (rub(inc), inc_tag, rub(t['ip'])))
    L.append('• закрыто категорий: %d из %d · %s ₽' % (t['closed'], t['cats'], rub(t['ef'])))
    L.append('• осталось открыто: %s ₽' % rub(t['open']))
    if t['dfact'] is not None:
        L.append('• дельта факт: <b>%s ₽</b>' % signed(t['dfact']))
    if t['locked']:
        L.append('• статус: ✓ месяц закрыт')
    L.append('')

    # пул и цели
    total = pool_total(st)
    free = pool_free(st)
    L.append('<b>Бонусный пул: %s ₽</b> (свободно %s ₽)' % (rub(total), rub(free)))
    stt = bonus_stats(st)
    if stt:
        L.append('• бонусы: медиана $%s · среднее $%s · %d мес' %
                 (rub(stt['median']), rub(stt['mean']), stt['n']))
    for g, saved in active_goals(st)[:4]:
        amount = g.get('amount', 0) or 0
        pct = min(100, saved / amount * 100) if amount else 0
        left = max(0, amount - saved)
        tm = g.get('targetMonth')
        mleft = max(0, ym_diff(ym, tm)) if tm else 0
        # прогноз: если весь средний бонус направлять сюда
        avg_rub = (s.get('bonusAvg', 0) or 0) * rate
        proj = saved + mleft * avg_rub
        ok = '✅' if proj >= amount else '⚠️'
        L.append('• «%s»: отложено %s / %s ₽ (%.0f%%) · до цели %s ₽ %s' %
                 (_html.escape(str(g.get('name', '—'))), rub(saved), rub(amount), pct, rub(left), ok))
    L.append('')

    # конверты
    funds = st.get('sinkingFunds', [])
    if funds:
        L.append('<b>Конверты</b>')
        for f in funds:
            L.append('• %s: %s ₽ (взнос %s ₽/мес)' %
                     (_html.escape(str(f.get('name', '—'))), rub(f.get('balance', 0)), rub(f.get('monthly', 0))))
        L.append('')

    # напоминания
    rem = []
    if today.day <= 6 and t['if_'] is None:
        prev = M_ROD[midx(ym_add(ym, -1))]
        rem.append('💰 Впиши <b>факт дохода</b> за %s — зп приходит 5-го числа.' % prev)
    # конец месяца — предложить закрыть
    last_day = (today.replace(day=28) + datetime.timedelta(days=4)).replace(day=1) - datetime.timedelta(days=1)
    if today.day >= last_day.day - 4 and not t['locked']:
        rem.append('📕 Конец месяца — пора «<b>закрыть месяц</b>» в приложении.')
    if today.day <= 6 and funds:
        rem.append('✉️ Не забудь «+ мес» по конвертам (взносы за месяц).')
    if rem:
        L.append('<b>Напоминания</b>')
        L.extend('• ' + r for r in rem)
        L.append('')

    L.append('<i>kg881.github.io/budget</i>')
    return '\n'.join(L).strip()


# ---------- отправка ----------
def send_telegram(token, chat_id, text):
    url = 'https://api.telegram.org/bot%s/sendMessage' % token
    data = urllib.parse.urlencode({
        'chat_id': chat_id,
        'text': text,
        'parse_mode': 'HTML',
        'disable_web_page_preview': 'true',
    }).encode()
    req = urllib.request.Request(url, data=data)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=DEFAULT_DATA, help='путь к data.json')
    ap.add_argument('--dry', action='store_true', help='печать в консоль, без отправки')
    args = ap.parse_args()

    load_secrets()

    if not os.path.exists(args.data):
        print('data.json не найден: %s' % args.data, file=sys.stderr)
        sys.exit(1)
    with open(args.data, encoding='utf-8') as f:
        st = json.load(f)

    text = build_digest(st)

    if args.dry:
        # для консоли уберём HTML-теги
        import re
        print(re.sub(r'</?[^>]+>', '', text))
        return

    token = os.environ.get('TG_BOT_TOKEN')
    chat_id = os.environ.get('TG_CHAT_ID')
    if not token or not chat_id:
        print('Нет TG_BOT_TOKEN / TG_CHAT_ID (env или ~/.claude/secrets/budget_tg.env). '
              'Запусти с --dry чтобы просто посмотреть текст.', file=sys.stderr)
        sys.exit(2)

    res = send_telegram(token, chat_id, text)
    if not res.get('ok'):
        print('Telegram error: %s' % res, file=sys.stderr)
        sys.exit(3)
    print('Отправлено.')


if __name__ == '__main__':
    main()
