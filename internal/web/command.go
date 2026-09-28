package web

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"time"

	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

func itoa(n int) string { return strconv.Itoa(n) }

func mapCommand() cli.Command {
	return cli.Command{
		Path:    "map",
		Summary: "打开只读网页（今天、部门、决定、执行者）；交互终端里直接开浏览器，否则打印一次性链接",
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(0); err != nil {
				return err
			}
			var link Link
			if err := c.Call("POST", "/api/web/link", nil, &link); err != nil {
				return err
			}
			text := fmt.Sprintf("网页：%s\n链接 %s 前有效，只能打开一次", link.URL,
				time.UnixMilli(link.ExpiresAt).Format("15:04:05"))
			if !c.JSON && interactive(c) {
				if err := openBrowser(link.URL); err != nil {
					text += "\n没能自动打开浏览器（" + err.Error() + "），请手动打开上面的链接"
				} else {
					text += "\n已在浏览器打开"
				}
			}
			return c.Done(link, text, "atrium task ls")
		},
	}
}

// interactive：标准输出是终端时才自动开浏览器（被 Agent 或管道调用时只打印链接）。
func interactive(c *cli.Ctx) bool {
	f, ok := c.Env.Stdout.(*os.File)
	if !ok {
		return false
	}
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

// browserInvocation 纯判定：各平台用什么打开网址。
func browserInvocation(goos, url string) platform.Invocation {
	switch goos {
	case "darwin":
		return platform.Invocation{Command: "open", Args: []string{url}}
	case "windows":
		return platform.Invocation{Command: "rundll32", Args: []string{"url.dll,FileProtocolHandler", url}}
	}
	return platform.Invocation{Command: "xdg-open", Args: []string{url}}
}

func openBrowser(url string) error {
	env := platform.EnvMap(os.Environ())
	inv := browserInvocation(runtime.GOOS, url)
	path, err := platform.LookPath(inv.Command, env)
	if err != nil {
		return err
	}
	cmd, err := platform.Start(platform.Spec{Path: path, Args: inv.Args, Env: env})
	if err != nil {
		return err
	}
	return cmd.Wait()
}
