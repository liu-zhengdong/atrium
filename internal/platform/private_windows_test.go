//go:build windows

package platform

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestPrivateFileRemovesBroadACL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	if _, sids := readDACL(t, path); !slices.Contains(sids, everyone) {
		t.Fatal("unsafe ACL fixture missing")
	}
	if err := WritePrivateFile(path, []byte("test-only")); err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	protected, sids := readDACL(t, path)
	want := []string{user.User.Sid.String(), "S-1-5-18", "S-1-5-32-544"}
	if !protected || !slices.Equal(sids, want) {
		t.Fatalf("protected = %v, allowed = %v, want protected %v", protected, sids, want)
	}
}

const everyone = "S-1-1-0"

// readDACL 返回 DACL 是否受保护与各条允许项的 SID（按 SID 比，不按 SDDL 文本：本机管理员账户在 SDDL 里写成别名 LA）。
func readDACL(t *testing.T, path string) (bool, []string) {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	var sids []string
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		if ace.Header.AceType == windows.ACCESS_ALLOWED_ACE_TYPE {
			sids = append(sids, (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String())
		}
	}
	return control&windows.SE_DACL_PROTECTED != 0, sids
}

func TestPrivateDirBlocksParentInheritance(t *testing.T) {
	parent := t.TempDir()
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(parent, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(parent, "data")
	if err := PrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "child")
	if err := os.WriteFile(path, []byte("test-only"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, sids := readDACL(t, path); slices.Contains(sids, everyone) {
		t.Fatal("child inherited Everyone access")
	}
}
