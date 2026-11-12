"""Keep a saved automation occurrence distinct from authoring its schedule."""


def for_run(instruction: str) -> str:
    # Legacy notes may contain the original creation request. Keep all business
    # details intact while making the dispatch intent explicit on both paths.
    return (
        "【执行已有自动化的本轮工作】\n"
        "这条自动化已由 SoduWork 保存，现在是一次实际运行。"
        "请直接完成说明中的每次执行内容，并返回本轮结果。\n"
        "说明中如果还包含创建本自动化、命名、设置触发时间、初始暂停或启用等要求，"
        "这些属于已经处理的计划配置，不是本轮工作；不要再次创建本自动化，"
        "不要为它生成配置文件、脚本或部署说明，也不要等待下一个触发时间。"
        "手动触发同样执行本轮工作，不修改计划的启停状态。\n"
        "保留并遵守每次执行内容中的工具、文件、网络、输出格式等限制；"
        "如果每次工作本身明确要求管理其他自动化，则按该业务要求执行。\n\n"
        "【已保存的工作说明】\n" + instruction
    )
