import type { ParsedRules } from "./types"

/**
 * 解析用户输入的规则
 * 格式：
 *   #文件发现规则：[描述要处理的文件]
 *   可能有多行描述
 *
 *   #文件处理规则：[描述处理方式]
 *   可能有多行描述
 *
 * @param input 用户输入的文本
 * @returns 解析后的规则信息
 */
export function parseRules(input: string): ParsedRules {
	const lines = input.split("\n")

	// 查找包含"文件发现规则"的行索引
	const discoveryIndex = lines.findIndex(
		(line) => line.includes("文件发现规则") || line.includes("File Discovery Rule"),
	)

	// 查找包含"文件处理规则"的行索引
	const processingIndex = lines.findIndex(
		(line) => line.includes("文件处理规则") || line.includes("File Processing Rule"),
	)

	// 如果同时存在两个规则，则为规则模式
	if (discoveryIndex !== -1 && processingIndex !== -1) {
		// 确定哪个规则在前，哪个在后
		const firstIndex = Math.min(discoveryIndex, processingIndex)
		const secondIndex = Math.max(discoveryIndex, processingIndex)

		// 提取文件发现规则内容（支持多行）
		let discoveryRule: string
		if (discoveryIndex < processingIndex) {
			// 文件发现规则在前，提取到文件处理规则之前
			discoveryRule = extractMultilineRuleContent(lines, discoveryIndex, processingIndex)
		} else {
			// 文件发现规则在后，提取到结尾
			discoveryRule = extractMultilineRuleContent(lines, discoveryIndex, lines.length)
		}

		// 提取文件处理规则内容（支持多行）
		let processingRule: string
		if (processingIndex < discoveryIndex) {
			// 文件处理规则在前，提取到文件发现规则之前
			processingRule = extractMultilineRuleContent(lines, processingIndex, discoveryIndex)
		} else {
			// 文件处理规则在后，提取到结尾
			processingRule = extractMultilineRuleContent(lines, processingIndex, lines.length)
		}

		if (discoveryRule && processingRule) {
			return {
				isRuleMode: true,
				discoveryRule: discoveryRule.trim(),
				processingRule: processingRule.trim(),
			}
		}
	}

	// 否则不是规则模式
	return {
		isRuleMode: false,
	}
}

/**
 * 从规则行开始提取多行内容
 * @param lines 所有行
 * @param startIndex 规则标识所在行的索引
 * @param endIndex 结束索引（下一个规则的索引或数组末尾）
 * @returns 提取的多行内容
 */
function extractMultilineRuleContent(lines: string[], startIndex: number, endIndex: number): string {
	const startLine = lines[startIndex]
	const contentLines: string[] = []

	// 提取第一行冒号后面的内容
	const firstLineContent = extractRuleContent(startLine)
	if (firstLineContent) {
		contentLines.push(firstLineContent)
	}

	// 收集后续行直到遇到下一个规则标识或结束
	for (let i = startIndex + 1; i < endIndex; i++) {
		const line = lines[i]

		// 如果遇到新的规则标识，停止
		if (
			line.includes("文件发现规则") ||
			line.includes("文件处理规则") ||
			line.includes("File Discovery Rule") ||
			line.includes("File Processing Rule")
		) {
			break
		}

		// 添加行内容（保留空行以维持格式）
		contentLines.push(line)
	}

	// 合并所有内容，用换行符连接以保持原始格式
	return contentLines.join("\n")
}

/**
 * 从规则行中提取冒号后面的内容
 * @param line 规则行
 * @returns 提取的内容
 */
function extractRuleContent(line: string): string {
	// 移除开头的 # 符号（如果有）
	const cleaned = line.replace(/^#+\s*/, "")

	// 查找冒号的位置（支持中英文冒号）
	const colonIndex = Math.max(cleaned.indexOf("："), cleaned.indexOf(":"))

	if (colonIndex !== -1) {
		// 返回冒号后面的内容
		return cleaned.substring(colonIndex + 1).trim()
	}

	// 如果没有冒号，返回整行内容（去掉标识符部分）
	return cleaned
		.replace(/文件发现规则/g, "")
		.replace(/文件处理规则/g, "")
		.replace(/File Discovery Rule/gi, "")
		.replace(/File Processing Rule/gi, "")
		.trim()
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
	return files
}
