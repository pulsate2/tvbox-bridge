package com.tvbox.bridge.diagnostics;

import java.util.Arrays;
import unicorn.ArmConst;
import unicorn.Arm64Const;
import unicorn.CodeHook;
import unicorn.Unicorn;
import unicorn.UnicornConst;

/** Deterministic native/JNI check; requires no content source or network. */
public final class UnicornCheck {
    public static void main(String[] args) {
        check("ARM", UnicornConst.UC_ARCH_ARM, ArmConst.UC_ARM_REG_R0,
                new byte[] { 0x2a, 0x00, (byte) 0xa0, (byte) 0xe3,
                             0x01, 0x00, (byte) 0x80, (byte) 0xe2 });
        check("AArch64", UnicornConst.UC_ARCH_ARM64, Arm64Const.UC_ARM64_REG_X0,
                new byte[] { 0x40, 0x05, (byte) 0x80, (byte) 0xd2,
                             0x00, 0x04, 0x00, (byte) 0x91 });
        System.out.println("[unicorn-check] Native load, execution, hooks and context checks passed");
    }

    private static void check(String name, int arch, int register, byte[] code) {
        long base = 0x100000;
        Unicorn emulator = new Unicorn(arch, UnicornConst.UC_MODE_ARM);
        long context = 0;
        try {
            emulator.mem_map(base, 0x1000, UnicornConst.UC_PROT_ALL);
            emulator.mem_write(base, code);
            if (!Arrays.equals(code, emulator.mem_read(base, code.length))) {
                throw new IllegalStateException(name + ": memory round trip failed");
            }
            int[] calls = { 0 };
            Unicorn.UnHook hook = emulator.hook_add(
                    (CodeHook) (uc, address, size, data) -> calls[0]++,
                    base, base + code.length - 1, null);
            try {
                emulator.emu_start(base, base + code.length, 1000000, 2);
            } finally {
                hook.unhook();
            }
            long result = readRegister(emulator, arch, register);
            if (result != 43 || calls[0] != 2) {
                throw new IllegalStateException(name + ": expected register=43, hooks=2; got register="
                        + result + ", hooks=" + calls[0]);
            }

            context = emulator.context_alloc();
            emulator.context_save(context);
            emulator.reg_write(register, 99);
            if (readRegister(emulator, arch, register) != 99) {
                throw new IllegalStateException(name + ": register write failed");
            }
            emulator.context_restore(context);
            if (readRegister(emulator, arch, register) != 43) {
                throw new IllegalStateException(name + ": context restore failed");
            }
            // These JNI methods were introduced in 1.0.15. An older native
            // resource can otherwise load successfully but break its Java API.
            if (emulator.getMemAllocatedSize() != 0x1000 || emulator.getMemResidentSize() != 0x1000) {
                throw new IllegalStateException(name + ": invalid native memory counters");
            }
            emulator.mem_unmap(base, 0x1000);
        } finally {
            try {
                emulator.closeAll();
            } finally {
                // This engine keeps a list of saved contexts until close.
                // Its JNI free() does not detach them from that list.
                if (context != 0) {
                    Unicorn.free(context);
                }
            }
        }
        System.out.println("[unicorn-check] " + name + ": register=43, hooks=2");
    }

    private static long readRegister(Unicorn emulator, int arch, int register) {
        long value = emulator.reg_read(register);
        // The JNI numeric read uses a jlong buffer, but ARM32 writes only its
        // low 32 bits. Check those bits; AArch64 uses the entire 64-bit value.
        return arch == UnicornConst.UC_ARCH_ARM ? value & 0xffffffffL : value;
    }
}
