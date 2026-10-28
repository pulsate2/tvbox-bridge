package android.graphics.drawable;

/**
 * Minimal android.graphics.drawable.Drawable stub（tvbox-bridge 补丁）。
 *
 * <p>在 xiugou-tv 原版 shim 基础上补齐 {@code ConstantState}：
 * 饭太硬载荷的 {@code com.github.catvod.spider.ProxyOrigin} 在 playerContent
 * 路径上会调用 {@code Drawable.getConstantState().newDrawable()}，缺少该内部类
 * 会让整个播放调用抛 NoClassDefFoundError（stage=call，站点暂不可用）。
 */
public abstract class Drawable {

    public void setAlpha(int alpha) {
    }

    public void setColorFilter(int color, android.graphics.PorterDuff.Mode mode) {
    }

    public int getIntrinsicWidth() {
        return 0;
    }

    public int getIntrinsicHeight() {
        return 0;
    }

    public ConstantState getConstantState() {
        return new ConstantState() {
            @Override
            public Drawable newDrawable() {
                return Drawable.this;
            }
        };
    }

    public static abstract class ConstantState {
        public abstract Drawable newDrawable();

        public int getChangingConfigurations() {
            return 0;
        }
    }
}