//go:build windows

package platform

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	readACL := func() string {
		t.Helper()
		actual, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(err)
		}
		return actual.String()
	}
	if !strings.Contains(readACL(), ";;;WD)") {
		t.Fatal("unsafe ACL fixture missing")
	}
	if err := WritePrivateFile(path, []byte("test-only")); err != nil {
		t.Fatal(err)
	}
	got := readACL()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "D:P") || strings.Count(got, "(A;") != 3 || !strings.Contains(got, ";;;"+user.User.Sid.String()+")") || !strings.Contains(got, ";;;SY)") || !strings.Contains(got, ";;;BA)") {
		t.Fatalf("unexpected ACL: %s", got)
	}
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
	actual, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(actual.String(), ";;;WD)") {
		t.Fatal("child inherited Everyone access")
	}
}
