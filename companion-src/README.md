# Java companion 源码

本目录包含构建 `companion-service.jar` 所需的 Java 源码，无需另外 checkout 上游仓库。

源码来源：[qfw66/xiugou-tv](https://github.com/qfw66/xiugou-tv)，固定于提交 [8f2632267b0c8ccb7c5e4f39c6e22845b7c844c7](https://github.com/qfw66/xiugou-tv/tree/8f2632267b0c8ccb7c5e4f39c6e22845b7c844c7)。

- `android-bridge/src/`：Android shim、CatVod 契约、Guard 解密、dex2jar、Spider RPC。
- `companion/src/`：伴随进程入口 `Main`。
- `deps.lock.json`：41 个第三方 JAR 的 Maven Central 地址、大小与 SHA-256。
- `LICENSE`：保留的上游 GPL-3.0 许可；第三方依赖各自保留其许可。

在项目根目录运行 `npm run build:companion`。构建先获取并校验依赖，再将源码复制到 `companion-build/build/src/`，在副本中应用 Android shim 补丁和运行时目录改写。产物写入 `companion/dist/`。

下载的依赖保存在本目录的 `companion/lib/`、`companion/lib-unidbg/`、`companion/libs/`，已加入 Git 忽略规则；它们通过锁定清单重建。
