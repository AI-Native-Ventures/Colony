//! Synthetic app-server protocol coverage. Never contacts a provider or reads auth.

use super::*;

#[cfg(unix)]
mod subprocess {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};
    use tempfile::TempDir;

    // Python is provided by the hosted macOS/Linux CI runners. The executable
    // reads and writes only this test's temporary profile and JSON-line pipes.
    const SERVER: &str = r#"#!/usr/bin/env python3
import json, os, pathlib, sys
profile = pathlib.Path(os.environ['CODEX_HOME'])
scenario = (profile / 'fixture-scenario').read_text()
def record(value):
    with (profile / 'fixture-trace').open('a') as trace:
        trace.write(json.dumps(value) + '\n')
record({'argv': sys.argv[1:], 'home': os.environ['HOME'], 'cwd': os.getcwd()})
if 'generate-json-schema' in sys.argv:
    if scenario == 'schema-failed':
        sys.exit(1)
    assert '--experimental' in sys.argv
    out = pathlib.Path(sys.argv[sys.argv.index('--out') + 1])
    target = out if scenario == 'schema-wrong-directory' else out / 'v2'
    target.mkdir(exist_ok=True)
    for name in ['ThreadStartParams', 'TurnStartParams']:
        if scenario == 'schema-missing-file' and name == 'TurnStartParams':
            continue
        schema = {'properties': {'environments': {'type': ['array', 'null']}}}
        if scenario == 'schema-missing-field' and name == 'TurnStartParams':
            schema['properties'] = {}
        if scenario == 'schema-wrong-type':
            schema['properties']['environments'] = {'type': 'object'}
        if scenario == 'schema-any-of':
            schema['properties']['environments'] = {'anyOf': [{'type': 'array'}, {'type': 'null'}]}
        (target / (name + '.json')).write_text(json.dumps(schema))
    sys.exit(0)
assert sys.argv[-3:] == ['app-server', '--listen', 'stdio://']
def emit(value):
    print(json.dumps(value), flush=True)
def answer(request, result):
    emit({'id': request['id'], 'result': result})
def notice(method, params):
    emit({'method': method, 'params': params})
model = 'fixture-model'
turn_count = 0
for line in sys.stdin:
    request = json.loads(line)
    record(request)
    method = request.get('method')
    if method == 'initialize':
        assert request['params']['capabilities']['experimentalApi'] is True
        answer(request, {'userAgent': 'synthetic-server'})
    elif method == 'account/read':
        kind = 'apiKey' if scenario == 'api-key-account' else 'chatgpt'
        answer(request, {'account': {'type': kind}})
    elif method == 'model/list':
        models = [{'id': 'catalog-id', 'model': model, 'hidden': False}]
        if scenario == 'missing-model':
            models = [{'model': 'another-model'}]
        if scenario == 'hidden-model':
            models[0]['hidden'] = True
        if scenario == 'paged-model' and request['params']['cursor'] is None:
            answer(request, {'data': [], 'nextCursor': 'second-page'})
        else:
            answer(request, {'data': models, 'nextCursor': None})
    elif method == 'thread/start':
        params = request['params']
        assert params['environments'] == []
        result = {'thread': {'id': 'fixture-thread'}, 'model': model,
                  'modelProvider': 'openai', 'approvalPolicy': 'never',
                  'sandbox': {'type': 'readOnly'}, 'cwd': str(profile),
                  'instructionSources': []}
        if scenario == 'wrong-model':
            result['model'] = 'another-model'
        if scenario == 'wrong-provider':
            result['modelProvider'] = 'another-provider'
        if scenario == 'wrong-workspace':
            result['cwd'] = str(profile.parent)
        if scenario == 'host-instructions':
            result['instructionSources'] = ['/synthetic/host/AGENTS.md']
        if scenario == 'missing-thread':
            result['thread']['id'] = ''
        answer(request, result)
    elif method == 'turn/start':
        params = request['params']
        assert params['environments'] == []
        assert params['model'] == model
        assert params['threadId'] == 'fixture-thread'
        assert all(item['type'] == 'text' for item in params['input'])
        turn_count += 1
        turn = 'fixture-turn-' + str(turn_count)
        if scenario == 'start-error':
            emit({'id': request['id'], 'error': {'code': -32000, 'message': 'PRIVATE PROVIDER DETAIL'}})
            continue
        if scenario == 'malformed-frame':
            print('not-json', flush=True)
            continue
        notice('turn/started', {'threadId': 'fixture-thread', 'turn': {'id': turn}})
        answer(request, {'turn': {'id': 'unexpected-turn' if scenario == 'wrong-turn' else turn}})
        if scenario == 'wrong-started-turn':
            notice('turn/started', {'threadId': 'fixture-thread', 'turn': {'id': 'unexpected-turn'}})
        if scenario == 'hang':
            notice('item/agentMessage/delta', {'threadId': 'fixture-thread', 'turnId': turn, 'delta': 'started'})
            continue
        if scenario == 'flood':
            for index in range(5):
                notice('item/agentMessage/delta', {'threadId': 'fixture-thread', 'turnId': turn, 'delta': str(index)})
            continue
        if scenario == 'approval-request':
            emit({'id': 'server-approval', 'method': 'item/commandExecution/requestApproval',
                  'params': {'threadId': 'fixture-thread', 'turnId': turn, 'command': 'synthetic forbidden command'}})
            reply = json.loads(sys.stdin.readline())
            record(reply)
            assert reply.get('error', {}).get('code') == -32601
            assert 'result' not in reply
        notice('item/agentMessage/delta', {'threadId': 'foreign-thread', 'turnId': turn, 'delta': 'FOREIGN THREAD'})
        notice('item/agentMessage/delta', {'threadId': 'fixture-thread', 'turnId': 'foreign-turn', 'delta': 'FOREIGN TURN'})
        notice('turn/completed', {'threadId': 'foreign-thread', 'turn': {'id': turn, 'status': 'completed'}})
        notice('turn/completed', {'threadId': 'fixture-thread', 'turn': {'id': 'foreign-turn', 'status': 'completed'}})
        notice('item/agentMessage/delta', {'threadId': 'fixture-thread', 'turnId': turn, 'delta': 'Ready for review.'})
        notice('thread/tokenUsage/updated', {'threadId': 'foreign-thread', 'turnId': turn,
               'tokenUsage': {'total': {'inputTokens': 999, 'outputTokens': 999}}})
        notice('thread/tokenUsage/updated', {'threadId': 'fixture-thread', 'turnId': turn,
               'tokenUsage': {'total': {'inputTokens': 40, 'outputTokens': 8, 'cachedInputTokens': 12},
                              'cost': 999, 'currency': 'USD'}})
        status = 'interrupted' if scenario == 'interrupted' else ('failed' if scenario == 'failed-turn' else 'completed')
        notice('turn/completed', {'threadId': 'fixture-thread', 'turn': {'id': turn, 'status': status}})
"#;

    struct Fixture {
        _directory: TempDir,
        config: Config,
    }

    impl Fixture {
        fn new(scenario: &str) -> Self {
            let directory = tempfile::tempdir().expect("synthetic protocol directory");
            let profile = directory.path().join("profile");
            let workspace = directory.path().join("workspace");
            fs::create_dir(&profile).expect("synthetic profile");
            fs::create_dir(&workspace).expect("synthetic workspace");
            fs::create_dir(profile.join("tmp")).expect("synthetic profile temporary directory");
            fs::write(profile.join("fixture-scenario"), scenario).expect("synthetic scenario");
            let vendor_binary = directory.path().join("fake-codex");
            fs::write(&vendor_binary, SERVER).expect("synthetic executable");
            fs::set_permissions(&vendor_binary, fs::Permissions::from_mode(0o700))
                .expect("synthetic executable permissions");
            Self {
                config: Config {
                    runtime: "codex".into(),
                    vendor_binary,
                    profile,
                    workspace,
                    model: "fixture-model".into(),
                    mcp_servers: json!({"colony_work": {
                        "command":"/usr/bin/sandbox-exec",
                        "args":["-f", "/synthetic/native-owned.sb", "/synthetic/work-tool"]
                    }}),
                    host_login: None,
                },
                _directory: directory,
            }
        }

        async fn start(&self) -> Result<Codex> {
            tokio::time::timeout(
                Duration::from_secs(5),
                Codex::start(&self.config, "Review the work."),
            )
            .await
            .expect("synthetic server must complete startup promptly")
        }

        fn trace(&self) -> Vec<Value> {
            fs::read_to_string(self.config.profile.join("fixture-trace"))
                .expect("synthetic trace")
                .lines()
                .map(|line| serde_json::from_str(line).expect("synthetic trace JSON"))
                .collect()
        }
    }

    fn text_input() -> Vec<Value> {
        vec![json!({"type":"text","text":"Prepare a short draft."})]
    }

    async fn prompt(agent: &mut Codex) -> (Result<&'static str>, Vec<Value>) {
        let (_cancel, cancellation) = watch::channel(false);
        let (updates, mut received) = mpsc::channel(16);
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            agent.prompt(text_input(), updates, cancellation),
        )
        .await
        .expect("synthetic turn must terminate promptly");
        let mut output = Vec::new();
        while let Ok(update) = received.try_recv() {
            output.push(update);
        }
        (outcome, output)
    }

    #[tokio::test]
    async fn schema_gate_rejects_missing_unsupported_and_failed_vendor_capabilities() {
        for scenario in [
            "schema-failed",
            "schema-missing-file",
            "schema-missing-field",
            "schema-wrong-type",
            "schema-wrong-directory",
        ] {
            let fixture = Fixture::new(scenario);
            assert!(fixture.start().await.is_err(), "{scenario}");
            assert_eq!(
                fixture.trace().len(),
                1,
                "unsupported vendors must never start app-server"
            );
            assert!(!fs::read_dir(&fixture.config.profile)
                .expect("profile entries")
                .any(|entry| entry
                    .expect("profile entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with("colony-schema-")));
        }
    }

    #[tokio::test]
    async fn subscription_and_selected_model_must_be_confirmed_before_work() {
        for scenario in [
            "api-key-account",
            "missing-model",
            "hidden-model",
            "wrong-model",
            "wrong-provider",
            "wrong-workspace",
            "host-instructions",
            "missing-thread",
        ] {
            let fixture = Fixture::new(scenario);
            assert!(fixture.start().await.is_err(), "{scenario}");
            assert!(fixture
                .trace()
                .iter()
                .all(|item| item["method"] != "turn/start"));
        }
    }

    #[tokio::test]
    async fn every_work_request_disables_environments_and_filters_foreign_turn_output() {
        let fixture = Fixture::new("paged-model");
        let mut agent = fixture.start().await.expect("compatible server");
        for _ in 0..2 {
            let (outcome, output) = prompt(&mut agent).await;
            assert_eq!(outcome.expect("completed turn"), "end_turn");
            assert_eq!(
                output,
                vec![
                    json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Ready for review."}}),
                    json!({"sessionUpdate":"usage_update","model":"fixture-model","accumulatedInputTokens":40,"accumulatedOutputTokens":8,"accumulatedCachedInputTokens":12}),
                ],
                "foreign thread/turn text, token usage and completions must not escape"
            );
        }
        agent.shutdown().await;
        let trace = fixture.trace();
        let requests: Vec<_> = trace
            .iter()
            .filter(|item| matches!(item["method"].as_str(), Some("thread/start" | "turn/start")))
            .collect();
        assert_eq!(requests.len(), 3);
        for request in requests {
            assert_eq!(request["params"]["environments"], json!([]));
            assert_eq!(request["params"]["approvalPolicy"], "never");
            assert_eq!(request["params"]["model"], "fixture-model");
        }
        assert_eq!(
            trace
                .iter()
                .filter(|item| item["method"] == "model/list")
                .count(),
            2
        );
        let thread = trace
            .iter()
            .find(|item| item["method"] == "thread/start")
            .expect("thread request");
        assert_eq!(
            thread["params"]["config"]["mcp_servers"]["colony_work"]["required"],
            true
        );
        assert_eq!(
            thread["params"]["config"]["mcp_servers"]["colony_work"]["cwd"],
            fixture.config.workspace.to_string_lossy().as_ref()
        );
    }

    #[tokio::test]
    async fn server_approval_requests_are_refused_without_granting_native_access() {
        let fixture = Fixture::new("approval-request");
        let mut agent = fixture.start().await.expect("compatible server");
        assert_eq!(
            prompt(&mut agent)
                .await
                .0
                .expect("turn after denied approval"),
            "end_turn"
        );
        agent.shutdown().await;
        let trace = fixture.trace();
        let reply = trace
            .iter()
            .find(|item| item["id"] == "server-approval")
            .expect("approval refused");
        assert_eq!(reply["error"]["code"], -32601);
        assert!(reply.get("result").is_none());
    }

    #[tokio::test]
    async fn failed_or_mismatched_turns_retire_the_session_without_exposing_vendor_details() {
        for scenario in [
            "wrong-turn",
            "wrong-started-turn",
            "start-error",
            "malformed-frame",
            "failed-turn",
        ] {
            let fixture = Fixture::new(scenario);
            let mut agent = fixture.start().await.expect("compatible server");
            let (outcome, _) = prompt(&mut agent).await;
            let error = outcome.expect_err(scenario).to_string();
            assert!(!error.contains("PRIVATE PROVIDER DETAIL"));
            assert!(!agent.usable, "{scenario}");
            assert!(
                prompt(&mut agent).await.0.is_err(),
                "retired session must not accept another turn"
            );
        }
    }

    #[tokio::test]
    async fn cancellation_and_closed_coordinator_retire_in_flight_work() {
        for close_sender in [false, true] {
            let fixture = Fixture::new("hang");
            let mut agent = fixture.start().await.expect("compatible server");
            let (cancel, cancellation) = watch::channel(false);
            let (updates, mut received) = mpsc::channel(2);
            let cancelling = async move {
                received.recv().await.expect("turn started");
                if !close_sender {
                    cancel.send(true).expect("request cancellation");
                }
                drop(cancel);
            };
            let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::join!(
                    agent.prompt(text_input(), updates, cancellation),
                    cancelling
                )
            })
            .await
            .expect("cancellation must terminate the child promptly");
            assert_eq!(result.expect("cancelled turn"), "cancelled");
            assert!(!agent.usable);
        }
    }

    #[tokio::test]
    async fn cancellation_can_interrupt_a_full_output_channel() {
        let fixture = Fixture::new("flood");
        let mut agent = fixture.start().await.expect("compatible server");
        let (cancel, cancellation) = watch::channel(false);
        let (updates, mut received) = mpsc::channel(1);
        let cancelling = async move {
            received.recv().await.expect("first message delivered");
            // Keep the receiver open and stop draining: the next delivery fills
            // the queue, then the vendor's subsequent delivery blocks.
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.send(true).expect("request cancellation");
            tokio::time::sleep(Duration::from_millis(200)).await;
            received
        };
        let (result, _received) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(
                agent.prompt(text_input(), updates, cancellation),
                cancelling
            )
        })
        .await
        .expect("backpressure must not suppress cancellation");
        assert_eq!(result.expect("cancelled turn"), "cancelled");
        assert!(!agent.usable);
    }

    #[tokio::test]
    async fn interrupted_vendor_turn_requires_reconnect_but_pre_cancel_does_not_send_work() {
        let fixture = Fixture::new("interrupted");
        let mut agent = fixture.start().await.expect("compatible server");
        let (_cancel, cancellation) = watch::channel(true);
        let (updates, _received) = mpsc::channel(1);
        assert_eq!(
            agent
                .prompt(text_input(), updates, cancellation)
                .await
                .expect("pre-cancelled"),
            "cancelled"
        );
        assert!(fixture
            .trace()
            .iter()
            .all(|item| item["method"] != "turn/start"));
        assert_eq!(
            prompt(&mut agent).await.0.expect("interrupted vendor turn"),
            "cancelled"
        );
        assert!(!agent.usable);
    }

    #[tokio::test]
    async fn union_schema_support_is_accepted_without_relaxing_thread_policy() {
        let fixture = Fixture::new("schema-any-of");
        let mut agent = fixture.start().await.expect("nullable array capability");
        agent.shutdown().await;
    }
}

#[test]
fn incomplete_token_usage_is_unknown_and_never_becomes_monetary_cost() {
    assert!(usage_update(
        &json!({"tokenUsage":{"total":{"inputTokens":7}}}),
        "fixture-model"
    )
    .is_none());
    assert!(usage_update(
        &json!({"tokenUsage":{"total":{"inputTokens":-1,"outputTokens":3}}}),
        "fixture-model"
    )
    .is_none());
    let update = usage_update(
        &json!({"tokenUsage":{"total":{"inputTokens":7,"outputTokens":3},"cost":22.5}}),
        "fixture-model",
    )
    .expect("token counts");
    assert_eq!(
        update,
        json!({"sessionUpdate":"usage_update","model":"fixture-model","accumulatedInputTokens":7,"accumulatedOutputTokens":3})
    );
}
