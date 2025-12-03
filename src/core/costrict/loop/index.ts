import * as vscode from "vscode"
import { ClineProvider } from "../../webview/ClineProvider"
import { getCommand } from "../../../utils/commands"
import { CostrictCommandId } from "@roo-code/types"
import { getVisibleProviderOrLog } from "../../../activate/registerCommands"
import { LoopService } from "./loopService"

/**
 * 初始化 Loop 功能
 * @param context VSCode 扩展上下文
 * @param provider ClineProvider 实例
 * @param outputChannel 输出通道
 */
export function initLoop(
	context: vscode.ExtensionContext,
	provider: ClineProvider,
	outputChannel: vscode.OutputChannel,
) {
	const loopService = LoopService.getInstance()
	loopService.setProvider(provider)

	// costrict change - used for the loop mode of costrict
	const commandMap: Partial<Record<CostrictCommandId, any>> = {
		// Loop 按钮点击 - 进入 Loop 模式
		zgsmLoopButtonClicked: async () => {
			let visibleProvider = getVisibleProviderOrLog(outputChannel)

			if (!visibleProvider) {
				visibleProvider = await ClineProvider.getInstance()
			}

			if (!visibleProvider) {
				return
			}

			// 通知 webview 切换到 Loop 界面
			visibleProvider.postMessageToWebview({ type: "action", action: "zgsmLoopButtonClicked" })
		},

		// 开始 Loop 任务
		zgsmStartLoopTask: async (userPrompt: string) => {
			const visibleProvider = await ClineProvider.getInstance()
			if (!visibleProvider) {
				return
			}

			loopService.setProvider(visibleProvider)

			try {
				await loopService.startLoopTask(userPrompt)
			} catch (error) {
				vscode.window.showErrorMessage(
					`Loop 任务失败: ${error instanceof Error ? error.message : String(error)}`,
				)
				visibleProvider.log(`[Loop] Task failed: ${error}`)
			}
		},

		// 取消 Loop 任务
		zgsmCancelLoopTask: async () => {
			loopService.cancelTask()
		},

		// 重置 Loop 状态
		zgsmResetLoop: async () => {
			loopService.reset()
		},
	}

	// 注册所有命令
	for (const [id, callback] of Object.entries(commandMap)) {
		const command = getCommand(id as CostrictCommandId)
		context.subscriptions.push(vscode.commands.registerCommand(command, callback))
	}
}

// 导出类型和服务
export { LoopService } from "./loopService"
export * from "./types"
