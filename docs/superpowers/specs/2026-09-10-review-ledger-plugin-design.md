# review-ledger 플러그인 설계 — 저자 ↔ 리뷰어 양방향 리뷰 원장

2026-09-10. matchably-mall-be(GUI-812, PR #483)와 그 원본인 자매 레포 `something`의 리뷰 원장 루프를 **레포별 복사본이 아니라 공개 Claude Code 플러그인**으로 추출한다. GitHub 배포는 사용자가 한다. 이 문서는 플러그인의 범위·구조·프로토콜·레포 어댑터·검증 기준을 확정한다.

## 1. 문제

한 방향 리뷰(diff → 지적 → 수정 → 새 리뷰)는 실측 10~20회전까지 늘어난다. 원인 네 가지는 matchably 설계 문서의 진단 그대로다.

1. 지적에 ID가 없다 → 고친 것·거부한 것이 다음 회전에 다른 문장으로 다시 올라온다.
2. 저자가 "거부·근거"를 돌려줄 채널이 없다 → 의도된 설계가 반복 지적된다.
3. 종료 조건이 `approve` 하나다 → P3 하나만 남아도 리뷰어가 yes를 못 한다.
4. 리뷰어 스레드가 회전마다 새로 열린다 → 앞선 판단을 잊고 처음부터 다시 발견한다.

Genit은 스크립트·훅 없이 프로즈 프로토콜만 있어 최대 6회전(레포 기록)·25회전(세션 메모리)이 났다. matchably는 원장 루프 도입 뒤 시드 런 6건이 2회전에 수렴했다.

레포별 복사는 이미 3세대(something → matchably → Genit 예정)라 드리프트가 확정적이다. 그래서 플러그인이다.

## 2. 범위

**1단계(이 스펙)**: 저자 = Claude Code 메인 루프, 리뷰어 = Codex `codex exec`(기본 `gpt-5.6-sol`). Claude Code 플러그인으로 전역 설치.

**2단계(별도 스펙)**: 대칭 루프 — 저자 = Codex, 리뷰어 = Claude(`claude -p`). `.codex-plugin/` 매니페스트와 리뷰어 엔진 `claude`는 그때 추가한다. 1단계는 엔진 인터페이스만 교체 가능하게 자른다.

**범위 밖**: 블라인드 저지(disputed 자동 판정), PR 코멘트 게시, 웹 UI.

## 3. 레포 구조 (플러그인 = 레포 루트, Spotify portal-ai-plugins 방식)

```
review-ledger/
├── .claude-plugin/plugin.json          # name "review-ledger", skills/hooks 선언
├── .claude-plugin/marketplace.json     # marketplace "review-ledger", plugins[0].source "./"
├── skills/review-ledger/SKILL.md         # 저자 절차(트리거·순서). 스크립트 경로는 "이 스킬 디렉터리 기준 ../../scripts"
├── hooks/hooks.json                    # Stop + PostToolUse(Edit|Write|MultiEdit), ${CLAUDE_PLUGIN_ROOT}
├── scripts/
│   ├── review-ledger.mjs                 # CLI 진입: init | open | reply | round | status | escalate | close
│   ├── hooks/review-stop-gate.mjs
│   ├── hooks/ledger-touch.mjs
│   └── lib/
│       ├── ledger.mjs                  # bootstrap/load/save/render, 상태 기계(applyReplies·computeStatus), dedup
│       ├── config.mjs                  # .review/config.json 로드·기본값 병합·검증
│       ├── request.mjs                 # R1/Rn 요청문 조립(루브릭 core + 레포 overlay + 페이로드)
│       ├── payload.mjs                 # scope 해석, git diff, inline 페이로드 수집·상한
│       ├── gates.mjs                   # 결정론 게이트 실행·결과 캡처
│       └── engines/codex.mjs           # open/resume 호출, thread_id 파싱, 스키마 검증, 프로브
├── templates/
│   ├── rubric.core.md                  # 심각도 정의·회신 규칙·출력 계약(엔진 중립, 영어)
│   ├── rubric.repo.md                  # 레포 overlay 템플릿("## Repository invariants" 골격)
│   ├── config.json                     # 기본 설정
│   └── review.schema.json
├── tests/                              # node --test, codex 미호출(가짜 엔진)
│   ├── ledger.test.mjs
│   ├── request.test.mjs
│   ├── payload.test.mjs
│   ├── config.test.mjs
│   ├── hooks.test.mjs
│   ├── e2e.test.mjs                    # fake-codex 로 open→reply→round→converged
│   └── fixtures/fake-codex.mjs         # PATH 선두에 놓는 가짜 codex(thread.started + 시나리오별 reply)
├── docs/protocol.md                    # 절차 정본(영어)
├── docs/protocol.ko.md                 # 한국어판
├── README.md                           # 설치·30초 사용법·설정 표
├── LICENSE                             # MIT
└── package.json                        # "test": "node --test tests/"
```

플러그인 코드는 Node 20+ ESM, 의존성 0. 셸 체인(`&&`·`cd`)을 만들지 않고 `spawnSync`로 codex를 직접 부른다(Genit 워크트리 세션 가드가 체인을 차단하므로).

## 4. 레포 어댑터 (`.review/`)

플러그인은 레포를 모른다. 레포는 `.review/`로 자신을 설명한다. `review-ledger init`이 골격을 만든다.

| 파일 | git | 내용 |
|---|---|---|
| `.review/config.json` | 커밋 | 아래 설정 표 |
| `.review/rubric.md` | 커밋 | 레포 overlay. 불변식(위반 = P0/P1)·생성물 제외·도메인 용어. **core 루브릭은 플러그인이 들고 있고 매 회전 core + overlay 순으로 붙인다** |
| `.review/ledger.json` · `ledger.md` | gitignore | 원장(기계·사람). 스크립트만 쓴다 |
| `.review/runs/<run_id>/r<n>.{request.md,reply.json,events.jsonl}` | gitignore | 회전별 감사 흔적 |

`init`은 `.gitignore`에 세 줄을 추가하고(이미 있으면 생략), 설정·overlay 템플릿을 복사하고, CLI 절대 경로를 출력한다.

### 설정 (`config.json`, 기본값)

```json
{
  "reviewer": { "engine": "codex", "model": "gpt-5.6-sol", "effort_open": "xhigh", "effort_round": "medium", "effort_reopen": "high" },
  "base": "origin/main",
  "blocking": ["P0", "P1"],
  "max_rounds": 3,
  "clean_rounds_required": 1,
  "timeout_ms": 1200000,
  "transport": "sandbox",
  "codex_sandbox": "read-only",
  "probe": true,
  "inline_max_bytes": 400000,
  "exclude": [".review"],
  "scopes": {},
  "gates": []
}
```

- `transport`: `sandbox` = 리뷰어가 `git diff`를 스스로 실행(matchably 방식). `inline` = 스크립트가 diff와 대상 파일 전문을 요청문에 넣고 `<tooling>` 블록으로 도구 호출을 금지(Genit 정착형 — read-only 샌드박스 ACL 고장 우회).
- `codex_sandbox`: R1의 `-s` 값. 기본 `read-only`. Genit처럼 read-only가 깨진 머신만 `danger-full-access` + `approval_policy=never`로 올린다. 공개 기본값은 절대 `danger-full-access`가 아니다.
- `probe`: `open` 전에 30초 프로브(저비용 모델·low, 셸 명령 1개). 실패하면 `transport=sandbox`일 때 중단하고 `--transport inline`을 권한다. `--no-probe`로 끈다.
- `scopes`: 이름 → `{ "include": [glob…], "exclude": [glob…] }`. `open --scope <name>`으로 선택. 미지정이면 base 대비 변경 파일 전부.
- `gates`: 문자열 배열. `open`·`round` 직전에 순서대로 실행하고 종료 코드·stdout 꼬리(설정 상한)를 요청문 `## Deterministic gates` 절에 붙인다. 실패해도 리뷰는 진행하되 결과를 리뷰어에게 보인다. Genit이면 `budget-check`·`persona-check --sync`·`agents-doc-lint`가 여기 들어간다.

## 5. 프로토콜 (matchably 설계 유지, 변경점만 표기)

### 5.1 회전 흐름

```
review-ledger open [--scope <name>] [--focus "…"] [--transport inline] [--base <ref>]
   → 프로브 → 게이트 → R1 요청문(core+overlay+타깃/페이로드+게이트 결과) → 리뷰어 새 스레드
   → findings 중복 접기·F1… 부여 → status=open
review-ledger reply <id> fix     --evidence "<명령과 결과>" [--commit sha]
review-ledger reply <id> reject  --reason "<file:line 근거>"
review-ledger reply <id> dispute --reason "<file:line 근거>"
review-ledger reply <id> defer   --reason "<티켓>"        # 차단 심각도 불가
review-ledger round [--effort medium]
   → 회신 안 된 open 지적 있으면 거부 ("the reply is the channel")
   → 게이트 → Rn 요청문(회신·동결·검증·논쟁 목록 + 변경분) → 같은 스레드 resume
   → 리뷰어는 모든 회신 ID에 accept_fix|fix_insufficient|accept_rejection|maintain|withdraw|reopen
   → 원장 반영 → status 계산
review-ledger status | escalate [--note] | close [--note]
```

### 5.2 지적 상태·수렴 (변경 없음)

`open → fixed_claimed → fixed_verified | rejected_by_author → rejected_accepted | disputed(maintain×2) | withdrawn | deferred | closed_by_user`

```
converged ⇔ 차단 지적 미해결 0 ∧ clean_streak ≥ clean_rounds_required
escalated ⇔ 남은 차단 지적 전부 disputed          → 사용자 판정
capped    ⇔ round ≥ max_rounds 미수렴             → 사용자 판정
stalled   ⇔ 열린 집합·HEAD 동일 ∧ 전이 0 ∧ 새 차단 0 → 사용자 판정
```

matchably가 sol 리뷰로 잡은 세 가지 수정(F4 상태 불일치 verdict는 답변으로 안 침, F5 미답 회신은 원장 미반영 + 프로토콜 위반 재요청 1회, F6 stalled는 전이 0일 때만)을 그대로 가져온다.

### 5.3 요청문 조립 (변경점)

R1 = `rubric.core.md` + `.review/rubric.md` + `## Target`(base·scope·focus) + 페이로드 + `## Deterministic gates` + "Round 1: leave replies empty".

- `sandbox`: 페이로드 = 실행할 diff 명령(리뷰어가 직접 실행).
- `inline`: 페이로드 = 맨 앞 `<tooling>` 블록(도구·셸·파일·스킬 조회 금지, 첫 출력이 최종 답) + `git diff <merge-base>` 본문 + scope 내 변경 파일 전문. `inline_max_bytes` 초과 시 파일 전문을 diff만으로 줄이고, 그래도 초과면 중단하고 scope를 좁히라고 안내한다.

Rn = core + overlay + 회신 블록(matchably 형식) + 동결/검증/논쟁 목록 + **변경분**(`sandbox`: 재실행 지시, `inline`: 직전 회전 HEAD 대비 diff만 — 스레드가 R1 전문을 기억) + 게이트 결과 + "NEW findings only".

리뷰어에게 저자 엔진을 밝히지 않는다(루브릭 규칙).

### 5.4 리뷰어 엔진 인터페이스

```js
// engines/codex.mjs
probe({ model, timeout })                       → { ok, error }
open({ request, model, effort, sandbox, schema, cwd, outFile, eventsFile, timeout }) → { ok, threadId, output, error }
resume({ threadId, request, effort, schema, outFile, eventsFile, timeout })          → { ok, output, error }
```

codex 인자: R1 `exec -m <model> -c model_reasoning_effort="<e>" -s <sandbox> -C <root> --skip-git-repo-check --json --output-schema <schema> -o <out> -`. Rn `exec resume <thread> -c model_reasoning_effort="<e>" --json --output-schema <schema> -o <out> -`(resume은 `-m`·`-s`를 받지 않는다 — 이 머신 codex 0.153.3 실측). `codex_sandbox=danger-full-access`면 `-c approval_policy="never"`를 덧붙인다. 2단계의 `claude` 엔진은 같은 세 함수를 구현한다.

### 5.5 훅 (플러그인 동봉, `hooks/hooks.json`)

- `Stop`: 원장 `open` + 차단 지적 잔존 → `{"decision":"block","reason":…}`(다음 명령 안내). `capped|escalated|stalled` → stderr 알림 후 통과. `stop_hook_active`·원장 없음·파싱 실패 → 무음 통과. 타임아웃 30초.
- `PostToolUse(Edit|Write|MultiEdit)`: 열린 지적 파일 편집 시 `additionalContext`로 회신 상기. 상태 불변.
- 원장 경로는 `CLAUDE_PROJECT_DIR/.review/ledger.json`. 없으면 훅은 아무것도 하지 않으므로 플러그인을 전역 설치해도 `init` 안 한 레포에는 영향이 없다.
- 플러그인 `codex` 컴패니언의 Stop 게이트(`codex setup --enable-review-gate`)와 병행하지 않는다(README에 명시).

## 6. 스킬 (`skills/review-ledger/SKILL.md`)

트리거: "review loop", "리뷰 루프", "adversarial review", "적대 리뷰", "codex review", "sol 리뷰", "/review-ledger", 그리고 완료 선언 직전. 본문은 순서만(init 여부 확인 → open → 지적마다 하나 회신, 인스턴스가 아니라 계열을 닫음 → round → 수렴/에스컬레이션 처리). 스크립트 경로는 "이 스킬 디렉터리에서 `../../scripts/review-ledger.mjs`"로 지시한다(superpowers 관례). 절차 정본은 docs/protocol.md.

## 7. 검증 기준

1. `node --test tests/` 전부 통과. 가짜 codex로 e2e: (a) 6건 → 전부 fix → R2 accept → `converged`; (b) reject → maintain ×2 → `disputed` → `escalated`; (c) 3회전 미수렴 → `capped`; (d) 미답 회신 → 원장 미변경 + 재요청 → 그래도 미답이면 회전 미계상; (e) `inline` 상한 초과 → 중단.
2. `claude plugin validate --strict .` 통과.
3. 로컬 마켓플레이스로 설치(`claude plugin marketplace add <path>` → `claude plugin install review-ledger@review-ledger`) 후 훅이 등록되고, `init` 안 한 레포에서 Stop 훅이 무해함을 실측.
4. Genit에서 실전 시드 런 1회(`transport=inline`, Genit overlay 루브릭): 저자 Claude·리뷰어 sol이 3회전 이내 `converged` 또는 사용자 판정 상태 도달. sol 호출 비용은 회전당 약 2.5만 토큰(메모리 실측) — 실행 전 고지.
5. 플러그인 자체 코드의 교차 리뷰: 작성 Claude → 리뷰 sol(불변식 #4). 이 루프로 자기 자신을 리뷰하는 것이 4번의 시드 런이다.

## 8. Genit 측 후속(별도 턴, 외부 콘텐츠 미열람 턴에서)

- `.review/config.json`(`transport: inline`, `codex_sandbox: danger-full-access`, gates 3종, scopes: `prompt|lorebook|persona|spec|docs`).
- `.review/rubric.md` overlay: P0 = 금지선(불변식 #2)·저작권 경계·계정 위험, P1 = 지시 구멍(유저 우회)·raw↔카드↔설정집 정합 파괴·자수 한도 초과·출력 규칙 누락, P2 = 관례 편차, P3 = 문체 nit. `.claude/rules/genit-input.md` 해당 절 인라인.
- AGENTS.md 검증 표의 "교차 리뷰" 행 → 이 루프로 교체, playbook §2.3 갱신, `agents-doc-lint` 통과 확인.

## 9. 결정 기록

- 공개 플러그인·MIT·영어 README/protocol + 한국어 protocol.ko(사용자 2026-09-10).
- Codex 저자 대칭 루프는 2단계(사용자 2026-09-10).
- Stop·PostToolUse 훅 도입 승인(사용자 2026-09-10).
- 공개 기본 샌드박스는 `read-only`; `danger-full-access`는 레포 설정으로만.
