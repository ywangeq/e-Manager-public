package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/larksuite/cli/internal/core"
)

func TestPinnedTokenDoesNotFollowDefaultAccountDuringRead(t *testing.T) {
	r := request{ContractVersion: "group-feishu-read.v2", AppID: "synthetic_app", OpenID: "synthetic_open_a", UnionID: "synthetic_union", Start: "2026-10-09T00:00:00Z", End: "2026-10-10T00:00:00Z"}
	current := "synthetic_open_a"
	configs, tokens, gets := 0, 0, 0
	d := deps{config: func(request) (*core.CliConfig, error) {
		configs++
		return &core.CliConfig{AppID: r.AppID, UserOpenId: current, Brand: core.BrandFeishu}, nil
	},
		token: func(cfg *core.CliConfig) (string, error) {
			tokens++
			if cfg.UserOpenId != "synthetic_open_a" {
				t.Fatal("wrong account")
			}
			return "private_token_a", nil
		}}
	d.get = func(ctx context.Context, token, path string, query url.Values, out any) error {
		gets++
		if token != "private_token_a" {
			t.Fatal("default account changed query token")
		}
		if gets == 1 {
			current = "synthetic_open_b"
			return json.Unmarshal([]byte(`{"code":0,"data":{"open_id":"synthetic_open_a","union_id":"synthetic_union"}}`), out)
		}
		current = "synthetic_open_a"
		if path != "/open-apis/calendar/v4/calendars/primary/events/instance_view" {
			t.Fatal("unexpected operation")
		}
		return json.Unmarshal([]byte(`{"code":0,"data":{"items":[{"event_id":"synthetic_event","summary":"synthetic meeting","status":"confirmed","app_link":"https://applink.feishu.cn/client/calendar/event/detail?key=synthetic","vchat":{"meeting_url":"https://vc.feishu.cn/j/synthetic"},"start_time":{"timestamp":"1791504000"},"end_time":{"timestamp":"1791507600"}}]}}`), out)
	}
	data, err := read(context.Background(), r, d)
	if err != nil || len(data.Events) != 1 || configs != 1 || tokens != 1 || gets != 2 {
		t.Fatal("pinned read failed")
	}
	if data.Events[0].CalendarURL != "https://applink.feishu.cn/client/calendar/event/detail?key=synthetic" || data.Events[0].MeetingURL != "https://vc.feishu.cn/j/synthetic" {
		t.Fatal("official links not preserved")
	}
	if data.Events[0].EventRef != "synthetic_event" {
		t.Fatal("stable event reference missing")
	}
	encoded, _ := json.Marshal(data)
	if strings.Contains(string(encoded), "private_token_a") {
		t.Fatal("token escaped")
	}
}

func TestIdentityMismatchNeverQueriesAgenda(t *testing.T) {
	r := request{ContractVersion: "group-feishu-read.v2", AppID: "synthetic_app", OpenID: "synthetic_open_a", UnionID: "", Start: "2026-10-09T00:00:00Z", End: "2026-10-10T00:00:00Z"}
	count := 0
	d := deps{config: func(request) (*core.CliConfig, error) {
		return &core.CliConfig{AppID: r.AppID, UserOpenId: r.OpenID, Brand: core.BrandFeishu}, nil
	}, token: func(*core.CliConfig) (string, error) { return "private_token", nil }}
	d.get = func(ctx context.Context, token, path string, q url.Values, out any) error {
		count++
		return json.Unmarshal([]byte(`{"code":0,"data":{"open_id":"synthetic_open_b"}}`), out)
	}
	if data, err := read(context.Background(), r, d); err == nil || data != nil || count != 1 {
		t.Fatal("wrong identity reached agenda")
	}
	d.config = func(request) (*core.CliConfig, error) { return nil, errors.New("private_configuration_error") }
	count = 0
	if _, err := read(context.Background(), r, d); err == nil || count != 0 {
		t.Fatal("config failure reached network")
	}
}

func TestIncompleteAgendaNeverBecomesEmptySuccess(t *testing.T) {
	r := request{ContractVersion: "group-feishu-read.v2", AppID: "synthetic_app", OpenID: "synthetic_open_a", UnionID: "", Start: "2026-10-09T00:00:00Z", End: "2026-10-10T00:00:00Z"}
	for _, body := range []string{`{}`, `{"code":0}`, `{"code":0,"data":null}`, `{"code":0,"data":{"items":"invalid"}}`, `{"code":0,"data":{"items":[null]}}`, `{"code":1,"data":{"items":[]}}`, `{"code":0,"data":{"items":[],"has_more":true}}`} {
		d := deps{config: func(request) (*core.CliConfig, error) {
			return &core.CliConfig{AppID: r.AppID, UserOpenId: r.OpenID, Brand: core.BrandFeishu}, nil
		}, token: func(*core.CliConfig) (string, error) { return "private_token", nil }}
		d.get = func(ctx context.Context, token, path string, q url.Values, out any) error {
			if path == "/open-apis/authen/v1/user_info" {
				return json.Unmarshal([]byte(`{"code":0,"data":{"open_id":"synthetic_open_a"}}`), out)
			}
			return json.Unmarshal([]byte(body), out)
		}
		if data, err := read(context.Background(), r, d); err == nil || data != nil {
			t.Fatal("incomplete agenda became success")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := read(ctx, r, deps{}); err == nil {
		t.Fatal("canceled read reached configuration")
	}
}

func TestOfficialLinksOnly(t *testing.T) {
	for _, value := range []string{"javascript:alert(1)", "https://vc.feishu.cn.evil.test/j/a", "https://user@vc.feishu.cn/j/a", "https://vc.feishu.cn:443/j/a", "https://vc.feishu.cn\\@evil.test", "https://vc.feishu.cn/j/a\n"} {
		if officialLink(value, false) || officialLink(value, true) {
			t.Fatal("untrusted link accepted")
		}
	}
	if !officialLink("https://applink.larkoffice.com/client/calendar/event/detail?key=a", true) || !officialLink("https://vc.feishu.cn/j/a", false) {
		t.Fatal("official link rejected")
	}
}

func TestOfficialEmptyInstanceViewIsSuccessful(t *testing.T) {
	r := request{ContractVersion: "group-feishu-read.v2", AppID: "synthetic_app", OpenID: "synthetic_open_a", UnionID: "", Start: "2026-10-09T00:00:00Z", End: "2026-10-10T00:00:00Z"}
	for _, body := range []string{`{"code":0,"data":{}}`, `{"code":0,"data":{"items":[]}}`, `{"code":0,"data":{"items":null}}`} {
		d := deps{config: func(request) (*core.CliConfig, error) {
			return &core.CliConfig{AppID: r.AppID, UserOpenId: r.OpenID, Brand: core.BrandFeishu}, nil
		}, token: func(*core.CliConfig) (string, error) { return "private_token", nil }}
		d.get = func(ctx context.Context, token, path string, q url.Values, out any) error {
			if path == "/open-apis/authen/v1/user_info" {
				return json.Unmarshal([]byte(`{"code":0,"data":{"open_id":"synthetic_open_a"}}`), out)
			}
			return json.Unmarshal([]byte(body), out)
		}
		data, err := read(context.Background(), r, d)
		if err != nil || data == nil || data.Events == nil || len(data.Events) != 0 {
			t.Fatal("successful empty instance view rejected")
		}
		encoded, _ := json.Marshal(data)
		if string(encoded) != `{"events":[]}` {
			t.Fatal("empty result contract changed")
		}
	}
}

func TestMailRegisteredReadUsesSameIdentityAndBoundedBody(t *testing.T) {
	r := request{ContractVersion: "group-feishu-read.v3", OperationID: "mail.messages.list", AppID: "synthetic_app", OpenID: "synthetic_open", PageSize: 5}
	calls := []string{}
	d := deps{config: func(request) (*core.CliConfig, error) {
		return &core.CliConfig{AppID: r.AppID, UserOpenId: r.OpenID, Brand: core.BrandFeishu}, nil
	}, token: func(*core.CliConfig) (string, error) { return "private_token", nil }}
	body := `{"code":0,"data":{"items":["mail_1",{"message_id":"mail_2"},{"id":"mail_3"}],"has_more":true,"page_token":"next"}}`
	d.get = func(ctx context.Context, token, endpoint string, q url.Values, out any) error {
		if token != "private_token" {
			t.Fatal("token changed")
		}
		calls = append(calls, endpoint)
		if endpoint == "/open-apis/authen/v1/user_info" {
			return json.Unmarshal([]byte(`{"code":0,"data":{"open_id":"synthetic_open"}}`), out)
		}
		if r.OperationID == "mail.messages.list" && (q.Get("folder_id") != "INBOX" || q.Get("page_size") != "5") {
			t.Fatal("wrong inbox request")
		}
		if r.OperationID == "mail.message.read" && (q.Get("format") != "plain_text_full" || !strings.HasSuffix(endpoint, "/mail_1")) {
			t.Fatal("wrong message request")
		}
		return json.Unmarshal([]byte(body), out)
	}
	value, err := executeOperation(context.Background(), r, d)
	if err != nil || len(calls) != 2 || value.(map[string]any)["hasMore"] != true {
		t.Fatal("list failed")
	}
	r.OperationID = "mail.message.read"
	r.PageSize = 0
	r.MessageRef = "mail_1"
	body = `{"code":0,"data":{"message":{"message_id":"mail_1","subject":"synthetic","head_from":{"name":"Sender","mail_address":"sender@example.invalid"},"internal_date":"1791504000000","body_plain_text":"c3ludGhldGlj"}}}`
	value, err = executeOperation(context.Background(), r, d)
	if err != nil || value.(map[string]any)["body"] != "synthetic" || value.(map[string]any)["bodyTruncated"] != false {
		t.Fatal("plain body decoding failed")
	}
	for _, invalid := range []string{`{"code":0}`, `{"code":0,"data":{"message":null}}`, `{"code":1,"data":{}}`, `{"code":0,"data":{"message":{"message_id":"wrong"}}}`, `{"code":0,"data":{"message":{"message_id":"mail_1","body_plain_text":"%bad%"}}}`} {
		body = invalid
		if _, err = executeOperation(context.Background(), r, d); err == nil {
			t.Fatal("invalid mail accepted")
		}
	}
	r.MessageRef = "../other"
	before := len(calls)
	if _, err = executeOperation(context.Background(), r, d); err == nil || len(calls) != before {
		t.Fatal("path injection reached network")
	}
	r.MessageRef = "mail_1"
	r.OperationID = "mail.send"
	if _, err = executeOperation(context.Background(), r, d); err == nil || len(calls) != before {
		t.Fatal("unregistered write reached network")
	}
}

func TestMailEmptyPagingAndEscapedOutputBounds(t *testing.T) {
	r := request{ContractVersion: "group-feishu-read.v3", OperationID: "mail.messages.list", AppID: "synthetic_app", OpenID: "synthetic_open", PageSize: 5}
	response := `{"code":0,"data":{}}`
	d := deps{config: func(request) (*core.CliConfig, error) {
		return &core.CliConfig{AppID: r.AppID, UserOpenId: r.OpenID, Brand: core.BrandFeishu}, nil
	}, token: func(*core.CliConfig) (string, error) { return "synthetic_token", nil }}
	d.get = func(ctx context.Context, token, endpoint string, q url.Values, out any) error {
		if endpoint == "/open-apis/authen/v1/user_info" {
			return json.Unmarshal([]byte(`{"code":0,"data":{"open_id":"synthetic_open"}}`), out)
		}
		return json.Unmarshal([]byte(response), out)
	}
	for _, body := range []string{`{"code":0,"data":{}}`, `{"code":0,"data":{"items":[]}}`, `{"code":0,"data":{"items":null}}`} {
		response = body
		value, err := executeOperation(context.Background(), r, d)
		if err != nil || len(value.(map[string]any)["messageRefs"].([]string)) != 0 || value.(map[string]any)["hasMore"] != false {
			t.Fatal("valid empty inbox rejected")
		}
	}
	for _, body := range []string{`{"code":0}`, `{"code":0,"data":null}`, `{"code":1,"data":{}}`, `{"code":0,"data":{"items":3}}`, `{"code":0,"data":{"has_more":true}}`, `{"code":0,"data":{"page_token":"bad\n"}}`} {
		response = body
		if _, err := executeOperation(context.Background(), r, d); err == nil {
			t.Fatal("invalid inbox accepted")
		}
	}
	r.OperationID = "mail.message.read"
	r.PageSize = 0
	r.MessageRef = "mail_1"
	encoded := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("\x01", 8000)))
	response = `{"code":0,"data":{"message":{"message_id":"mail_1","body_plain_text":"` + encoded + `"}}}`
	value, err := executeOperation(context.Background(), r, d)
	if err != nil {
		t.Fatal(err)
	}
	bytes, _ := json.Marshal(value)
	if len(bytes) > 32*1024 || value.(map[string]any)["bodyTruncated"] != true {
		t.Fatal("escaped output not bounded")
	}
	r.ContractVersion = "group-feishu-read.v2"
	r.OperationID = ""
	if _, err := executeOperation(context.Background(), r, d); err == nil {
		t.Fatal("v2 mail field was ignored")
	}
}
