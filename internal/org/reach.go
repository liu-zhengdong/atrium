package org

import (
	"errors"

	"github.com/liu-zhengdong/atrium/internal/api"
)

// 负责人能动哪些部门由 org/leaders 的统一权限判定（路由之前）管；这里只剩「只有用户能做」的几件事。

// CheckUser 只让用户做（拍板、凭据）。
func CheckUser(actor api.Actor, what string) error {
	if actor.Kind == "user" {
		return nil
	}
	return api.Forbidden("只有用户能%s（%s 不行）", what, actor.ID)
}

func isCode(err error, code string) bool {
	var ae *api.Error
	return errors.As(err, &ae) && ae.Code == code
}
