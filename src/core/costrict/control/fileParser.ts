import * as path from "path"
import { mentionRegexGlobal } from "../../../shared/context-mentions"
import { listFiles } from "../../../services/glob/list-files"
import { CoIgnoreController } from "../codebase-index/CoIgnoreController"
import { isPathInIgnoredDirectory } from "../../../services/glob/ignore-utils"
import type { ExtractedPathInfo } from "./types"

/**
 * 从用户提示词中提取目录路径
 * 使用项目中已有的 mentionRegex 来匹配 @/xxx 格式的路径
 * @param prompt 用户输入的提示词
 * @param cwd 当前工作目录
 * @returns 提取的路径信息
 */
export function extractDirectoryFromPrompt(prompt: string, cwd: string): ExtractedPathInfo {
	// 使用全局正则匹配所有 mention
	const matches = prompt.match(mentionRegexGlobal)

	if (!matches || matches.length === 0) {
		return {
			directory: "",
			hasPath: false,
			cleanedPrompt: prompt,
		}
	}

	// 查找第一个目录路径
	for (const match of matches) {
		// 移除 @ 符号和可能的空格
		const pathStr = match.trim().substring(1).trim()

		// 过滤掉特殊的 mention (problems, git-changes, terminal 等)
		if (
			pathStr === "problems" ||
			pathStr === "git-changes" ||
			pathStr === "terminal" ||
			pathStr.startsWith("http://") ||
			pathStr.startsWith("https://") ||
			/^[a-f0-9]{7,40}$/.test(pathStr) // Git commit hash
		) {
			continue
		}

		// 处理以 / 开头的路径
		if (pathStr.startsWith("/")) {
			// 移除路径中的转义空格
			const cleanPath = pathStr.replace(/\\ /g, " ")

			// 移除开头的 "/" 得到相对路径
			const relativePath = cleanPath.startsWith("/") ? cleanPath.substring(1) : cleanPath

			// 从提示词中移除该路径
			const cleanedPrompt = prompt.replace(match, "").trim()

			return {
				directory: relativePath,
				hasPath: true,
				cleanedPrompt,
			}
		}
	}

	// 没有找到有效的目录路径
	return {
		directory: "",
		hasPath: false,
		cleanedPrompt: prompt,
	}
}

/**
 * 获取指定目录下的所有文件,并使用 .coignore 进行过滤
 * @param directory 要扫描的目录 (相对路径)
 * @param cwd 当前工作目录
 * @param limit 文件数量限制
 * @returns 过滤后的文件列表 (相对路径)
 */
export async function getFilteredFiles(directory: string, cwd: string, limit: number = 1000): Promise<string[]> {
	// 将相对路径转换为绝对路径
	const absolutePath = path.isAbsolute(directory) ? directory : path.join(cwd, directory)

	// 使用 listFiles 获取所有文件 (已经考虑了 .gitignore)
	const [allFiles, reachedLimit] = await listFiles(absolutePath, true, limit)

	// 初始化 CoIgnoreController 来处理 .coignore 规则
	const ignoreController = new CoIgnoreController(cwd)
	await ignoreController.initialize()

	// 过滤文件
	const filteredFiles = allFiles
		.filter((file) => {
			// 排除目录 (以 / 结尾)
			if (file.endsWith("/")) {
				return false
			}

			// 使用 CoIgnoreController 检查文件是否被忽略
			if (ignoreController.coignoreContentInitialized) {
				const relativePath = path.relative(cwd, file)
				if (!ignoreController.validateAccess(file)) {
					return false
				}
			}

			// 使用内置的忽略模式
			if (isPathInIgnoredDirectory(file)) {
				return false
			}

			return true
		})
		.map((file) => {
			// 返回相对于 cwd 的相对路径
			return path.relative(cwd, file).replace(/\\/g, "/")
		})

	return filteredFiles
}

/**
 * 验证目录是否存在且可访问
 * @param directory 目录路径 (可以是相对或绝对路径)
 * @param cwd 当前工作目录
 * @returns 是否存在且可访问
 */
export async function validateDirectory(directory: string, cwd: string): Promise<boolean> {
	const fs = require("fs").promises
	const absolutePath = path.isAbsolute(directory) ? directory : path.join(cwd, directory)

	try {
		const stat = await fs.stat(absolutePath)
		return stat.isDirectory()
	} catch (error) {
		return false
	}
}

/**
 * 过滤文件列表,只保留指定扩展名的文件
 * @param files 文件列表
 * @param extensions 允许的扩展名列表 (如 ['.ts', '.js'])
 * @returns 过滤后的文件列表
 */
export function filterFilesByExtension(files: string[], extensions: string[]): string[] {
	if (extensions.length === 0) {
		return files
	}

	const normalizedExtensions = extensions.map((ext) => ext.toLowerCase())

	return files.filter((file) => {
		const ext = path.extname(file).toLowerCase()
		return normalizedExtensions.includes(ext)
	})
}
