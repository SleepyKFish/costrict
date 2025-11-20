import type { ParsedRules } from "./types"

/**
 * 解析用户输入的规则
 * @param input 用户输入的文本
 * @returns 解析后的规则信息
 */
export function parseRules(input: string): ParsedRules {
	const lines = input.split("\n").map((line) => line.trim())

	// 查找 # 开头的文件发现规则
	const discoveryLine = lines.find((line) => line.startsWith("#"))
	// 查找 $ 开头的文件处理规则
	const processingLine = lines.find((line) => line.startsWith("$"))

	// 如果同时存在两个规则，则为规则模式
	if (discoveryLine && processingLine) {
		return {
			isRuleMode: true,
			discoveryRule: discoveryLine.substring(1).trim(), // 移除 # 符号
			processingRule: processingLine.substring(1).trim(), // 移除 $ 符号
		}
	}

	// 否则为传统模式
	return {
		isRuleMode: false,
		originalPrompt: input,
	}
}

/**
 * 从 LLM 响应中提取文件列表
 * 支持多种格式：JSON 数组、逐行文件路径、Markdown 代码块等
 * @param response LLM 的响应文本
 * @returns 文件路径数组
 */
export function extractFileListFromResponse(response: string): string[] {
	const files: string[] = []

	// 尝试 1: 查找 JSON 数组格式
	const jsonArrayMatch = response.match(/\[[\s\S]*?\]/)
	if (jsonArrayMatch) {
		try {
			const parsed = JSON.parse(jsonArrayMatch[0])
			if (Array.isArray(parsed)) {
				const validFiles = parsed.filter((item) => typeof item === "string" && item.trim().length > 0)
				if (validFiles.length > 0) {
					return validFiles.map((f) => f.trim())
				}
			}
		} catch (e) {
			// JSON 解析失败，继续尝试其他方法
		}
	}

	// 尝试 2: 查找代码块中的文件列表
	const codeBlockMatch = response.match(/```(?:json|txt|text)?\s*([\s\S]*?)```/)
	if (codeBlockMatch) {
		const content = codeBlockMatch[1]
		// 尝试作为 JSON 解析
		try {
			const parsed = JSON.parse(content)
			if (Array.isArray(parsed)) {
				const validFiles = parsed.filter((item) => typeof item === "string" && item.trim().length > 0)
				if (validFiles.length > 0) {
					return validFiles.map((f) => f.trim())
				}
			}
		} catch (e) {
			// 不是 JSON，按行分割
			const lines = content
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("#"))
			if (lines.length > 0) {
				return lines
			}
		}
	}

	// 尝试 3: 查找以 - 或 * 开头的列表项（Markdown 格式）
	const listItemRegex = /^[\s]*[-*]\s+(.+)$/gm
	let match
	while ((match = listItemRegex.exec(response)) !== null) {
		const filePath = match[1].trim()
		// 移除可能的代码标记
		const cleanPath = filePath.replace(/^`|`$/g, "")
		if (cleanPath.length > 0) {
			files.push(cleanPath)
		}
	}
	if (files.length > 0) {
		return files
	}

	// 尝试 4: 查找看起来像文件路径的行（包含 / 或文件扩展名）
	const lines = response.split("\n")
	for (const line of lines) {
		const trimmed = line.trim()
		// 跳过明显不是文件路径的行
		if (
			trimmed.length === 0 ||
			trimmed.length > 300 || // 太长的行不太可能是文件路径
			trimmed.includes("文件") ||
			trimmed.includes("File") ||
			trimmed.startsWith("//") ||
			trimmed.startsWith("#") ||
			trimmed.startsWith(">")
		) {
			continue
		}

		// 检查是否包含路径分隔符或常见文件扩展名
		if (
			trimmed.includes("/") ||
			trimmed.includes("\\") ||
			/\.(ts|tsx|js|jsx|py|java|go|rs|cpp|c|h|css|scss|html|vue|json|yaml|yml|md|txt)$/i.test(trimmed)
		) {
			// 移除可能的序号、引号等
			const cleanPath = trimmed
				.replace(/^\d+[.)]\s*/, "") // 移除序号
				.replace(/^["'`]|["'`]$/g, "") // 移除引号
				.trim()
			if (cleanPath.length > 0) {
				files.push(cleanPath)
			}
		}
	}

	return files
}
