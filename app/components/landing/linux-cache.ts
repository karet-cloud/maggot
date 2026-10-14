import type { Commit, Diff, TreeEntry } from "../../lib/api.ts";

// Cached from torvalds/linux on 2026-10-14. File links open the live public mirror.
export const LINUX_ROOT: TreeEntry[] = [
  {
    "name": "arch",
    "path": "arch",
    "type": "tree",
    "hash": "230ae3a83408ed2475a2ff7aa7651efd61b6f12c"
  },
  {
    "name": "block",
    "path": "block",
    "type": "tree",
    "hash": "0117b277f164b69c5bf641bf621de5ef9311229e"
  },
  {
    "name": "certs",
    "path": "certs",
    "type": "tree",
    "hash": "ac16f5c2f9b64af297cf149eec44a0e096be7a26"
  },
  {
    "name": "crypto",
    "path": "crypto",
    "type": "tree",
    "hash": "679885cfeb62e14aa18f81373496de21a5307ace"
  },
  {
    "name": "Documentation",
    "path": "Documentation",
    "type": "tree",
    "hash": "6b43a6dcd48734984a4dcd1f4fa39a8ee9b912e4"
  },
  {
    "name": "drivers",
    "path": "drivers",
    "type": "tree",
    "hash": "3bd4a7b01368c9c25db1d4e783d88cf15906bbf2"
  },
  {
    "name": "fs",
    "path": "fs",
    "type": "tree",
    "hash": "81532aaecd36e6e24ce9e74d3eede103776093d7"
  },
  {
    "name": "include",
    "path": "include",
    "type": "tree",
    "hash": "06ce49fac138d26897fcaf4841a57c16577b29a5"
  },
  {
    "name": "init",
    "path": "init",
    "type": "tree",
    "hash": "f8a15c936e6cd9586db39ed1ac1ff9ccd91cd301"
  },
  {
    "name": "io_uring",
    "path": "io_uring",
    "type": "tree",
    "hash": "6be2f950ae8cb6d7bec1c397cec9d032dd94d93c"
  },
  {
    "name": "ipc",
    "path": "ipc",
    "type": "tree",
    "hash": "05f7ef9fe73afedee8620162459080e7b1659e45"
  },
  {
    "name": "kernel",
    "path": "kernel",
    "type": "tree",
    "hash": "03e8cd43b5b36c394c768e7166e0c5ead6181998"
  },
  {
    "name": "lib",
    "path": "lib",
    "type": "tree",
    "hash": "a5c184657006a802d05b3a73a4c34a85558cdb45"
  },
  {
    "name": "LICENSES",
    "path": "LICENSES",
    "type": "tree",
    "hash": "79f3b0c41edc06100643bfc997718d71bc167894"
  },
  {
    "name": "mm",
    "path": "mm",
    "type": "tree",
    "hash": "d051810cd41e015d0f31b1360b5dd47fc717bba0"
  },
  {
    "name": "net",
    "path": "net",
    "type": "tree",
    "hash": "ed9cb713d874ec1cae09df806b3ebdbdd15d6e41"
  },
  {
    "name": "rust",
    "path": "rust",
    "type": "tree",
    "hash": "d1c74b75e84dc02e23bbe6b90e0753be08a2c4f6"
  },
  {
    "name": "samples",
    "path": "samples",
    "type": "tree",
    "hash": "deefe478cd4339d5665f2fcad2e8d7dcd1508443"
  },
  {
    "name": "scripts",
    "path": "scripts",
    "type": "tree",
    "hash": "15897b616fd70289d1a0101d669453fa711a57d8"
  },
  {
    "name": "security",
    "path": "security",
    "type": "tree",
    "hash": "66bfa0d0fa934c2ac7ecea5b5ce5a0b195b118c1"
  },
  {
    "name": "sound",
    "path": "sound",
    "type": "tree",
    "hash": "3502af7cbf3044d5ec278959bcda8d34a6010407"
  },
  {
    "name": "tools",
    "path": "tools",
    "type": "tree",
    "hash": "e60734974240809760168e3bd0007a38ee69c7bb"
  },
  {
    "name": "usr",
    "path": "usr",
    "type": "tree",
    "hash": "aef7b04970012a53149e092dee37080e4387818e"
  },
  {
    "name": "virt",
    "path": "virt",
    "type": "tree",
    "hash": "7dd7592dde793d695f4034800728b86a1342aaa8"
  },
  {
    "name": ".clang-format",
    "path": ".clang-format",
    "type": "blob",
    "hash": "5ef5743b77c95ff3971c16a7af7eecac345abed3"
  },
  {
    "name": ".clippy.toml",
    "path": ".clippy.toml",
    "type": "blob",
    "hash": "b0a78cc8be20c73e66c2fd1e874a0fdbe4cda339"
  },
  {
    "name": ".cocciconfig",
    "path": ".cocciconfig",
    "type": "blob",
    "hash": "43967c6b20151ee126db08e24758e3c789bcb844"
  },
  {
    "name": ".editorconfig",
    "path": ".editorconfig",
    "type": "blob",
    "hash": "69718ac91747a4d3eb3315a00b93f3e0d0215ca1"
  },
  {
    "name": ".get_maintainer.ignore",
    "path": ".get_maintainer.ignore",
    "type": "blob",
    "hash": "d19b725fd803b9387ae70822eee3b916c067679c"
  },
  {
    "name": ".gitattributes",
    "path": ".gitattributes",
    "type": "blob",
    "hash": "2325c529e1854545a1b611b72ad156bdbc4319cf"
  },
  {
    "name": ".gitignore",
    "path": ".gitignore",
    "type": "blob",
    "hash": "9875120ea7bde02d4ac6b7ebd19d2177eb07d1e3"
  },
  {
    "name": ".mailmap",
    "path": ".mailmap",
    "type": "blob",
    "hash": "0a0be49bc4de6cfb7446665349dd323d21a44125"
  },
  {
    "name": ".pylintrc",
    "path": ".pylintrc",
    "type": "blob",
    "hash": "8c6fc2b628b3e933b51cbbca54b1cf9ce266e12f"
  },
  {
    "name": ".rustfmt.toml",
    "path": ".rustfmt.toml",
    "type": "blob",
    "hash": "3de5cc497465c2722e160cb76188a8b287e48b7f"
  },
  {
    "name": "COPYING",
    "path": "COPYING",
    "type": "blob",
    "hash": "a635a38ef9405fdfcfe97f3a435393c1e9cae971"
  },
  {
    "name": "CREDITS",
    "path": "CREDITS",
    "type": "blob",
    "hash": "a0bd941ca5dd262301c29362d0b4bc5a1675fb5e"
  },
  {
    "name": "Kbuild",
    "path": "Kbuild",
    "type": "blob",
    "hash": "a6a0192dea08a1d66949d1bcb84c091010e5102f"
  },
  {
    "name": "Kconfig",
    "path": "Kconfig",
    "type": "blob",
    "hash": "307e581144de32a074883e44101cc6873080d1f9"
  },
  {
    "name": "MAINTAINERS",
    "path": "MAINTAINERS",
    "type": "blob",
    "hash": "f53047aa8d3c103edaab227e7a21e50f6d9fd733"
  },
  {
    "name": "Makefile",
    "path": "Makefile",
    "type": "blob",
    "hash": "0dc1a9f4e63ec47a8dbfdb964436e2260ce6fd04"
  },
  {
    "name": "README",
    "path": "README",
    "type": "blob",
    "hash": "010c587224224ba1254657b42b091a6c62c39e92"
  }
];
export const LINUX_README = "Linux kernel\n============\n\nThe Linux kernel is the core of any Linux operating system. It manages hardware,\nsystem resources, and provides the fundamental services for all other software.\n\nQuick Start\n-----------\n\n* Report a bug: See Documentation/admin-guide/reporting-issues.rst\n* Get the latest kernel: https://kernel.org\n* Build the kernel: See Documentation/admin-guide/quickly-build-trimmed-linux.rst\n* Join the community: https://lore.kernel.org/\n\nEssential Documentation\n-----------------------\n\nAll users should be familiar with:\n\n* Building requirements: Documentation/process/changes.rst\n* Code of Conduct: Documentation/process/code-of-conduct.rst\n* License: See COPYING\n\nDocumentation can be built with make htmldocs or viewed online at:\nhttps://www.kernel.org/doc/html/latest/\n\n\nWho Are You?\n============\n\nFind your role below:\n\n* New Kernel Developer: Getting started with kernel development\n* Academic Researcher: Studying kernel internals and architecture\n* Security Expert: Hardening and vulnerability analysis\n* Backport/Maintenance Engineer: Maintaining stable kernels\n* System Administrator: Configuring and troubleshooting\n* Maintainer: Leading subsystems and reviewing patches\n* Hardware Vendor: Writing drivers for new hardware\n* Distribution Maintainer: Packaging kernels for distros\n* AI Coding Assistant: LLMs and AI-powered development tools\n\n\nFor Specific Users\n==================\n\nNew Kernel Developer\n--------------------\n\nWelcome! Start your kernel development journey here:\n\n* Getting Started: Documentation/process/development-process.rst\n* Your First Patch: Documentation/process/submitting-patches.rst\n* Coding Style: Documentation/process/coding-style.rst\n* Build System: Documentation/kbuild/index.rst\n* Development Tools: Documentation/dev-tools/index.rst\n* Kernel Hacking Guide: Documentation/kernel-hacking/hacking.rst\n* Core APIs: Documentation/core-api/index.rst\n\nAcademic Researcher\n-------------------\n\nExplore the kernel's architecture and internals:\n\n* Researcher Guidelines: Documentation/process/researcher-guidelines.rst\n* Memory Management: Documentation/mm/index.rst\n* Scheduler: Documentation/scheduler/index.rst\n* Networking Stack: Documentation/networking/index.rst\n* Filesystems: Documentation/filesystems/index.rst\n* RCU (Read-Copy Update): Documentation/RCU/index.rst\n* Locking Primitives: Documentation/locking/index.rst\n* Power Management: Documentation/power/index.rst\n\nSecurity Expert\n---------------\n\nSecurity documentation and hardening guides:\n\n* Security Documentation: Documentation/security/index.rst\n* LSM Development: Documentation/security/lsm-development.rst\n* Self Protection: Documentation/security/self-protection.rst\n* Reporting Vulnerabilities: Documentation/process/security-bugs.rst\n* CVE Procedures: Documentation/process/cve.rst\n* Embargoed Hardware Issues: Documentation/process/embargoed-hardware-issues.rst\n* Security Features: Documentation/userspace-api/seccomp_filter.rst\n\nBackport/Maintenance Engineer\n-----------------------------\n\nMaintain and stabilize kernel versions:\n\n* Stable Kernel Rules: Documentation/process/stable-kernel-rules.rst\n* Backporting Guide: Documentation/process/backporting.rst\n* Applying Patches: Documentation/process/applying-patches.rst\n* Subsystem Profile: Documentation/maintainer/maintainer-entry-profile.rst\n* Git for Maintainers: Documentation/maintainer/configure-git.rst\n\nSystem Administrator\n--------------------\n\nConfigure, tune, and troubleshoot Linux systems:\n\n* Admin Guide: Documentation/admin-guide/index.rst\n* Kernel Parameters: Documentation/admin-guide/kernel-parameters.rst\n* Sysctl Tuning: Documentation/admin-guide/sysctl/index.rst\n* Tracing/Debugging: Documentation/trace/index.rst\n* Performance Security: Documentation/admin-guide/perf-security.rst\n* Hardware Monitoring: Documentation/hwmon/index.rst\n\nMaintainer\n----------\n\nLead kernel subsystems and manage contributions:\n\n* Maintainer Handbook: Documentation/maintainer/index.rst\n* Pull Requests: Documentation/maintainer/pull-requests.rst\n* Managing Patches: Documentation/maintainer/modifying-patches.rst\n* Rebasing and Merging: Documentation/maintainer/rebasing-and-merging.rst\n* Development Process: Documentation/process/maintainer-handbooks.rst\n* Maintainer Entry Profile: Documentation/maintainer/maintainer-entry-profile.rst\n* Git Configuration: Documentation/maintainer/configure-git.rst\n\nHardware Vendor\n---------------\n\nWrite drivers and support new hardware:\n\n* Driver API Guide: Documentation/driver-api/index.rst\n* Driver Model: Documentation/driver-api/driver-model/driver.rst\n* Device Drivers: Documentation/driver-api/infrastructure.rst\n* Bus Types: Documentation/driver-api/driver-model/bus.rst\n* Device Tree Bindings: Documentation/devicetree/bindings/\n* Power Management: Documentation/driver-api/pm/index.rst\n* DMA API: Documentation/core-api/dma-api.rst\n\nDistribution Maintainer\n-----------------------\n\nPackage and distribute the kernel:\n\n* Stable Kernel Rules: Documentation/process/stable-kernel-rules.rst\n* ABI Documentation: Documentation/ABI/README\n* Kernel Configuration: Documentation/kbuild/kconfig.rst\n* Module Signing: Documentation/admin-guide/module-signing.rst\n* Kernel Parameters: Documentation/admin-guide/kernel-parameters.rst\n* Tainted Kernels: Documentation/admin-guide/tainted-kernels.rst\n\nAI Coding Assistant\n-------------------\n\nCRITICAL: If you are an LLM or AI-powered coding assistant, you MUST read and\nfollow the AI coding assistants documentation before contributing to the Linux\nkernel:\n\n* Documentation/process/coding-assistants.rst\n\nThis documentation contains essential requirements about licensing, attribution,\nand the Developer Certificate of Origin that all AI tools must comply with.\n\n\nCommunication and Support\n=========================\n\n* Mailing Lists: https://lore.kernel.org/\n* IRC: #kernelnewbies on irc.oftc.net\n* Bugzilla: https://bugzilla.kernel.org/\n* MAINTAINERS file: Lists subsystem maintainers and mailing lists\n* Email Clients: Documentation/process/email-clients.rst\n";
export const LINUX_COMMITS: Commit[] = [
  {
    "hash": "0fcb05b72344f40806cbe810de8872f1698bf053",
    "message": "Merge tag 'libcrypto-fixes-for-linus' of git://git.kernel.org/pub/scm/linux/kernel/git/ebiggers/linux",
    "author": {
      "name": "Linus Torvalds",
      "email": ""
    },
    "parents": [
      "a",
      "b"
    ],
    "committedAt": 1791991417
  },
  {
    "hash": "4056b3c9d3c92ea45955641dbafeb9b960e146ef",
    "message": "Merge tag 'nios2_update_for_v7.4' of git://git.kernel.org/pub/scm/linux/kernel/git/dinguyen/linux",
    "author": {
      "name": "Linus Torvalds",
      "email": ""
    },
    "parents": [
      "a",
      "b"
    ],
    "committedAt": 1791940018
  },
  {
    "hash": "d77bd0d469e1923e587bb919301c0bb29093e30a",
    "message": "Merge tag 'for-v7.3-rc' of git://git.kernel.org/pub/scm/linux/kernel/git/sre/linux-power-supply",
    "author": {
      "name": "Linus Torvalds",
      "email": ""
    },
    "parents": [
      "a",
      "b"
    ],
    "committedAt": 1791939731
  }
];
// Actual upstream patch; discussions around it in the landing demo are fictional.
export const LINUX_DIFF: Diff = {
  "truncated": false,
  "additions": 1,
  "deletions": 1,
  "files": [
    {
      "path": "lib/crypto/poly1305.c",
      "status": "modified",
      "oldMode": "100644",
      "newMode": "100644",
      "additions": 1,
      "deletions": 1,
      "binary": false,
      "tooLarge": false,
      "hunks": [
        {
          "oldStart": 78,
          "oldLines": 7,
          "newStart": 78,
          "newLines": 7,
          "lines": [
            " \t}",
            " ",
            " \tpoly1305_emit(&desc->state.h, dst, desc->s);",
            "-\t*desc = (struct poly1305_desc_ctx){};",
            "+\tmemzero_explicit(desc, sizeof(*desc));",
            " }",
            " EXPORT_SYMBOL(poly1305_final);",
            " "
          ]
        }
      ]
    }
  ]
};
export const LINUX_PATCH_SOURCE = "https://github.com/torvalds/linux/commit/da619121a5d271e78ec709a1f9a3c5f99b9e10ad";
