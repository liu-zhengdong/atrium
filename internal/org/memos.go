package org

// 备忘：秘书与每位负责人各一份，覆盖写，上限 MaxMemo 字；超了拒绝，让写的人自己精简。

import (
	"context"
	"database/sql"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

type Memo struct {
	Owner     string `json:"owner"`
	Body      string `json:"body"`
	UpdatedBy string `json:"updated_by,omitempty"`
	UpdatedAt int64  `json:"updated_at,omitempty"`
}

// MemoOwner 纯判定：这次读写的是谁的备忘。用户（秘书会话用用户令牌）缺省是秘书的，可 --as 看任何人；
// 负责人只能是自己的。
func MemoOwner(actor api.Actor, as string) (string, error) {
	switch actor.Kind {
	case "user":
		if as == "" {
			return Secretary, nil
		}
		if as != Secretary && !api.IsRef(as, "a") {
			return "", api.Usage("--as: 应为 secretary 或负责人 aN，收到 %q", as)
		}
		return as, nil
	case "leader":
		if as != "" && as != actor.ID {
			return "", api.Forbidden("负责人只能读写自己的备忘（你是 %s）", actor.ID)
		}
		return actor.ID, nil
	}
	return "", api.Forbidden("%s 没有备忘", actor.ID)
}

// CheckMemo 纯判定：超上限拒绝并提示精简。
func CheckMemo(owner, body string) error {
	if n := utf8.RuneCountInString(body); n > MaxMemo {
		return api.Limit("atrium memo show --as "+owner,
			"备忘最多 %d 字，这次 %d 字：删掉已经过时的、合并重复的，只留下次醒来必须知道的", MaxMemo, n)
	}
	return nil
}

func GetMemo(ctx context.Context, q store.Querier, owner string) (Memo, error) {
	if _, err := GetIdentity(ctx, q, owner); err != nil {
		return Memo{}, err
	}
	m := Memo{Owner: owner}
	err := q.QueryRowContext(ctx, `SELECT body, updated_by, updated_at FROM memos WHERE identity = ?`, owner).
		Scan(&m.Body, &m.UpdatedBy, &m.UpdatedAt)
	if store.IsNotFound(err) {
		return m, nil
	}
	return m, err
}

// SetMemo 覆盖写一份备忘。
func SetMemo(ctx context.Context, db *store.DB, owner, body, by string) (Memo, error) {
	if err := CheckMemo(owner, body); err != nil {
		return Memo{}, err
	}
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := GetIdentity(ctx, tx, owner); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO memos (identity, body, updated_by, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (identity) DO UPDATE SET body = excluded.body, updated_by = excluded.updated_by,
			updated_at = excluded.updated_at`, owner, body, by, store.Now())
		return err
	})
	if err != nil {
		return Memo{}, err
	}
	return GetMemo(ctx, db, owner)
}
