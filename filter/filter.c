#include <windows.h>
#include <stdint.h>
static wchar_t module_path[32768];
static int is_cli(const wchar_t *s) {
    for (; *s; ++s) if (s[0]=='-' && s[1]=='-' && s[2]=='c' && s[3]=='l' && s[4]=='i') return 1;
    return 0;
}
static void log_number(char **p, unsigned n) {
    if(n>=10)log_number(p,n/10);
    *(*p)++=(char)('0'+n%10);
}
static void log_result(unsigned applied, int rc) {
    char line[160]="Web receiver filter: requested=1530000 Hz applied=";
    char *p=line;while(*p)++p;log_number(&p,applied);
    const char *tail=" Hz result=";while(*tail)*p++=*tail++;
    if(rc<0){*p++='-';rc=-rc;}log_number(&p,(unsigned)rc);*p++='\n';*p=0;
    DWORD written;WriteFile(GetStdHandle(STD_ERROR_HANDLE),line,(DWORD)(p-line),&written,NULL);
}
BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,LPVOID reserved){return TRUE;}


typedef int (__cdecl *set_freq_fn)(void *, uint32_t);
typedef int (__cdecl *set_bw_fn)(void *, uint32_t, uint32_t *, int);

/* All other exports forward unchanged to the original bundled driver.
 * Apply the GUI default after tuning: the driver requires a center frequency. */
int __cdecl rtlsdr_set_center_freq(void *dev, uint32_t frequency) {
    HMODULE self = NULL;
    wchar_t *path=module_path;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
            GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            (LPCWSTR)&rtlsdr_set_center_freq, &self)) return -1;
    DWORD length = GetModuleFileNameW(self, path, 32768);
    if (!length || length >= 32768) return -1;
    wchar_t *slash=NULL;for(wchar_t *p=path;*p;++p)if(*p==L'\\')slash=p;
    if (!slash || (slash - path) + 22 >= 32768) return -1;
    const wchar_t *name=L"rtlsdr_original.dll";wchar_t *out=slash+1;while((*out++=*name++)){}
    HMODULE original = GetModuleHandleW(path);
    if (!original) original = LoadLibraryW(path);
    if (!original) return -1;
    set_freq_fn set_freq = (set_freq_fn)GetProcAddress(original, "rtlsdr_set_center_freq");
    set_bw_fn set_bw = (set_bw_fn)GetProcAddress(original, "rtlsdr_set_and_get_tuner_bandwidth");
    if (!set_freq || !set_bw) return -1;
    int rc = set_freq(dev, frequency);
    if (rc || !is_cli(GetCommandLineW())) return rc;
    uint32_t applied = 0;
    rc = set_bw(dev, 1530000, &applied, 1);
    log_result(applied,rc);
    return rc;
}
