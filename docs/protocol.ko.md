# review-loop 프로토콜

English: [protocol.md](./protocol.md)

## 1. 문제

한 방향 리뷰(diff → 지적 → 수정 → 새 리뷰)는 실측 10~20회전까지 늘어난다. 원인은 넷이다.

1. 지적에 ID가 없다 → 고친 것·거부한 것이 다음 회전에 다른 문장으로 다시 올라온다.
2. 저자가 "거부·근거"를 돌려줄 채널이 없다 → 의도된 설계가 반복 지적된다.
3. 종료 조건이 `approve` 하나다 → P3 하나만 남아도 리뷰어가 yes를 못 한다.
4. 리뷰어 스레드가 회전마다 새로 열린다 → 앞선 판단을 잊고 처음부터 다시 발견한다.

원장이 넷을 전부 닫는다. ID, 필수 저자 회신, 차단 심각도 게이트 + 회전 상한, 그리고 매 회전 같은 리뷰어 스레드 resume.

## 2. 구성 요소

| 경로 | 역할 | git |
|---|---|---|
| `templates/rubric.core.md` (플러그인) | 심각도 정의·회신 판정·출력 계약. 매 회전 맨 앞에 원문 그대로 전송 | 플러그인 |
| `.review/rubric.md` | 레포 절: 불변식(위반 = P0/P1)·리뷰 제외 생성물·도메인 용어. core 다음에 매 회전 전송 | 커밋 |
| `.review/config.json` | 리뷰어 모델·effort, base, 차단 심각도, 회전 상한, transport, scopes, gates | 커밋 |
| `.review/ledger.json` · `.review/ledger.md` | 원장(기계·사람). CLI만 쓴다. `open`이 만든다 | **gitignore** |
| `.review/runs/<run_id>/r<n>.{request.md,reply.json,events.jsonl}` | 회전별 감사 흔적 | **gitignore** |
| `scripts/review-loop.mjs` | `init` · `open` · `reply` · `round` · `status` · `escalate` · `close` | 플러그인 |
| `hooks/hooks.json` | Stop 게이트 + PostToolUse 상기 | 플러그인 |

## 3. 회전 흐름

```
RL open [--scope <name>] [--focus "…"] [--transport inline] [--base <ref>]
   → 프로브(sandbox) → 게이트 → R1 요청문 → 리뷰어 새 스레드
   → 지적 중복 접기, F1… ID 부여, 스레드 ID 저장. status=open
RL reply F1 fix     --evidence "node --test → 12 passed" [--commit 9be1d0c]
RL reply F3 reject  --reason "src/x.js:31 에서 이미 검증"
RL reply F4 dispute --reason "멱등키 src/y.js:44"
RL reply F6 defer   --reason "P3, ticket-123"          # P2·P3만
RL round [--effort medium]
   → 회신 안 된 open 지적이 있으면 거부("회신이 채널이다")
   → 게이트 → Rn 요청문(회신·동결·검증·논쟁 목록 + 변경분) → 같은 스레드 resume
   → 리뷰어는 모든 회신 ID에 accept_fix | fix_insufficient | accept_rejection | maintain | withdraw | reopen 을 답하고
     새 지적만 낸다(다른 anchor)
   → 원장 반영, status 계산
RL status | escalate [--note] | close [--note]
```

## 4. 상태와 수렴

지적 상태: `open → fixed_claimed(저자 fix) → fixed_verified(accept_fix) | rejected_by_author → rejected_accepted(accept_rejection) | disputed(maintain ×2) | withdrawn | deferred | closed_by_user`.

```
converged ⇔ 차단 지적 중 open·fixed_claimed·rejected_by_author·disputed 가 0
            ∧ clean_streak ≥ clean_rounds_required   (clean = 새 차단 0 ∧ fix_insufficient 0 ∧ maintain 0 ∧ reopen 0)
escalated ⇔ 남은 차단 지적이 전부 disputed                       → 사용자 판정
capped    ⇔ round ≥ max_rounds 이고 미수렴                        → 사용자 판정
stalled   ⇔ 열린 집합·HEAD 동일 ∧ 전이 0 ∧ 새 차단 0 이 두 회전 연속 → 사용자 판정
```

- 차단은 `blocking`(기본 P0·P1)뿐이다. P2·P3는 기록·회신하되 루프를 붙잡지 않는다.
- 같은 ID에 `maintain` 두 번이면 `disputed`로 굳고 세 번째 논쟁은 열지 않는다.
- `reopen`은 동결·검증 항목에 20자 초과 새 근거가 있을 때만 받고, 아니면 버린다.
- 리뷰어 실행 실패·타임아웃(`timeout_ms`, 기본 20분)·스키마 불일치는 회전으로 세지 않는다. 한 번 재시도, 그래도 실패면 `escalate`.
- 미답 회신 ID는 프로토콜 위반이다. 원장을 건드리지 않고 위반을 명시해 한 번 재요청하고, 그래도 미답이면 회전을 세지 않는다.
- `close --note`로 사용자 판정을 남긴다. 미종결 지적은 전부 `closed_by_user`.

기본값: `blocking=[P0,P1]`, `max_rounds=3`, `clean_rounds_required=1`, `timeout_ms=1200000`.

## 5. 리뷰어 호출

R1(새 스레드, 모델·effort·샌드박스 명시):

```sh
codex exec -m gpt-5.6-sol -c model_reasoning_effort="xhigh" -s read-only -C "$REPO" --skip-git-repo-check \
  --json --output-schema templates/review.schema.json -o .review/runs/<run>/r1.reply.json - < .review/runs/<run>/r1.request.md
```

R2 이후(같은 스레드; `resume`은 모델·샌드박스를 상속하고 `-m`·`-s`를 받지 않는다):

```sh
codex exec resume "$THREAD" -c model_reasoning_effort="medium" \
  --json --output-schema templates/review.schema.json -o .review/runs/<run>/r2.reply.json - < .review/runs/<run>/r2.request.md
```

스레드 ID는 `--json` 첫 이벤트 `thread.started`에서 읽는다. 회신 회전은 약 2만 입력 토큰이라 `effort_round`는 `medium`, `reopen`이 걸린 회전만 `effort_reopen`(`high`). `codex_sandbox: "danger-full-access"`면 CLI가 `-c approval_policy="never"`를 덧붙인다.

## 6. 전송 방식(transport)

- **sandbox**(기본): 리뷰어가 read-only 샌드박스에서 `git diff $(git merge-base <base> HEAD)`를 직접 실행하고 필요한 파일을 읽는다. R1 전에 30초 프로브(`reviewer.probe_model`, low, 셸 명령 1개)로 샌드박스 exec 생존을 확인한다. `deny-read ACLs`가 뜨면 중단하고 `--transport inline`을 권한다.
- **inline**: 요청문 맨 앞에 도구 호출을 금지하는 `<tooling>` 블록을 두고 diff와 scope 내 변경 파일 전문을 넣는다. `inline_max_bytes`를 넘으면 파일 전문을 빼고 diff만, diff마저 넘으면 중단하고 scope를 좁히라고 안내한다. R2부터는 직전 회전 HEAD 대비 diff와 R1 이후 새로 생긴 파일 전문만 보낸다. 스레드가 R1 페이로드를 기억한다. 깨끗한 변경분을 위해 `open` 전에 커밋한다.

## 7. scope와 gate

- `scopes`: 이름 → `{ include, exclude }` 글로브. `open --scope <name>`으로 리뷰 파일을 제한한다. 미지정이면 base 대비 변경 파일 전부에서 `exclude`를 뺀다.
- `gates`: R1과 매 회전 직전에 CLI가 실행하는 셸 명령(테스트·린트·예산 검사). 종료 코드와 출력 꼬리를 `## Deterministic gates` 절로 요청문에 붙여 리뷰어가 저자 말이 아니라 기계 근거를 본다. 게이트 실패가 회전을 막지는 않는다.

## 8. 저자 규칙

- 인스턴스가 아니라 **계열**을 닫는다. 리뷰어는 표면 반례 하나만 준다. 같은 클래스의 다른 경로를 먼저 찾아 막고 회신에 적는다.
- fix 회신은 실행한 명령과 결과를 적는다. "고쳤다"는 근거가 아니다.
- 거부·논쟁은 `file:line`을 적는다. 리뷰어가 추적할 수 없는 거부는 `maintain`을 부른다.
- 리뷰어는 파일을 고치지 않는다. 다른 데 위임한 구현물도 저자 산출물로 다시 리뷰된다.
- 리뷰어에게 작성 엔진을 밝히지 않는다.

## 9. 훅

- **Stop**: 원장이 `open`이고 차단 지적이 남았으면 턴을 끝낼 수 없다. 차단 사유에 다음 명령이 적힌다. `capped`·`escalated`·`stalled`는 stderr에 알리고 통과. `stop_hook_active`·원장 없음·파싱 실패는 무음 통과.
- **PostToolUse(Edit | Write | MultiEdit)**: open·fixed_claimed·rejected_by_author 지적이 가리키는 파일을 편집하면 다음 회전 전에 회신하라는 상기를 넣는다. 원장은 바꾸지 않는다.
- 둘 다 `<repo>/.review/ledger.json`만 읽으므로 `init` 안 한 레포에서는 아무 일도 하지 않는다.
- 다른 Stop 시점 재리뷰 게이트(예: Codex 컴패니언 플러그인의 것)를 함께 켜지 않는다. 원장 없이 매 stop마다 재리뷰하는 것이 무한 핑퐁의 원인이다.
