package leaders

import (
	"context"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
)

func TestChoiceVoidPermission(t *testing.T) {
	_, h, srv := fixture(t)
	ctx := context.Background()
	tok, err := h.issue("a2")
	if err != nil {
		t.Fatal(err)
	}
	a2 := &api.Client{Base: srv.URL, Token: tok}
	user := &api.Client{Base: srv.URL, Token: "user"}
	secretary := &api.Client{Base: srv.URL, Token: "user", As: "secretary"}
	makeChoice := func(dept string) agenda.Choice {
		var c agenda.Choice
		if err := user.Do(ctx, "POST", "/api/choices", choice(dept), &c); err != nil {
			t.Fatal(err)
		}
		return c
	}
	own, other := makeChoice("o2"), makeChoice("o3")
	body := map[string]string{"reason": "用户已改选 22"}
	for _, tc := range []struct {
		client   *api.Client
		id, want string
	}{
		{user, own.ID, "forbidden"},
		{a2, other.ID, "forbidden"},
		{a2, "c999", "not_found"},
		{a2, own.ID, "ok"},
		{user, own.ID, "forbidden"},
		{secretary, other.ID, "ok"},
		{a2, own.ID, "conflict"},
	} {
		if got := code(tc.client.Do(ctx, "POST", "/api/choices/"+tc.id+"/void", body, nil)); got != tc.want {
			t.Errorf("%s: %s != %s", tc.id, got, tc.want)
		}
	}
	c := makeChoice("o2")
	if err := user.Do(ctx, "POST", "/api/choices/"+c.ID+"/decide", map[string]any{"picks": nil}, nil); err != nil {
		t.Fatal(err)
	}
	if got := code(a2.Do(ctx, "POST", "/api/choices/"+c.ID+"/void", body, nil)); got != "conflict" {
		t.Fatal(got)
	}
}
