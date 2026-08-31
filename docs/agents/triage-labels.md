# Triage Labels

에이전트 스킬이 사용하는 다섯 가지 triage 역할을 Linear의 기존 라벨에 다음과 같이 매핑합니다.

| 스킬의 역할 | Linear 라벨 | 의미 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 유지보수자의 분류와 판단이 필요함 |
| `needs-info` | `needs-info` | 제보자나 요청자의 추가 정보가 필요함 |
| `ready-for-agent` | `ready-for-agent` | 명세가 충분하여 에이전트가 실행할 수 있음 |
| `ready-for-human` | `ready-for-human` | 사람의 구현이나 판단이 필요함 |
| `wontfix` | `wontfix` | 진행하지 않기로 결정함 |

스킬이 역할 이름을 언급하면 이 표의 Linear 라벨을 사용합니다. 같은 역할의 새 라벨을 만들지 않습니다.
