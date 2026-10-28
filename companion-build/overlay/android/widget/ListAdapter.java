package android.widget;

/**
 * Minimal android.widget.ListAdapter stub（tvbox-bridge 补丁）。
 *
 * <p>饭太硬载荷的 {@code Pan} 在初始化时引用该接口；缺少时后台线程会抛
 * NoClassDefFoundError。基础播放路径不依赖它，但补上可避免噪声与潜在空指针。
 */
public interface ListAdapter {
    int getCount();

    Object getItem(int position);

    long getItemId(int position);
}