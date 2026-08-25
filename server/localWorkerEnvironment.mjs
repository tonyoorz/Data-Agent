const LOCAL_WORKER_BASE_KEYS = new Set([
  "COMSPEC",
  "CUDA_VISIBLE_DEVICES",
  "APPDATA",
  "DYLD_LIBRARY_PATH",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "LD_LIBRARY_PATH",
  "LOGNAME",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "Path",
  "REQUESTS_CA_BUNDLE",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TORCH_HOME",
  "USER",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);
const LOCAL_WORKER_PREFIXES = [
  "CUDA_",
  "DUPSEARCH_LOCAL_",
  "HF_",
  "HUGGINGFACE_",
  "KMP_",
  "MKL_",
  "MODELSCOPE_",
  "NVIDIA_",
  "OMP_",
];

export function resolveLocalWorkerEnvironment(env = process.env) {
  return {
    ...Object.fromEntries(Object.entries(env || {}).filter(([key]) => (
      LOCAL_WORKER_BASE_KEYS.has(key)
      || LOCAL_WORKER_PREFIXES.some((prefix) => key.startsWith(prefix))
    ))),
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
  };
}
