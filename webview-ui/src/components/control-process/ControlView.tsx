import React, { useState, useCallback, useEffect, useRef } from "react"
import { vscode } from "../../utils/vscode"
import { type ControlTaskProgress, type SubTask, ControlTaskStatus, SubTaskStatus } from "./types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { cn } from "../../lib/utils"
import { ChatTextArea } from "../chat/ChatTextArea"
import { useExtensionState } from "@src/context/ExtensionStateContext"

interface ControlViewProps {
	isHidden?: boolean
	onSwitchToChat?: () => void
}

/**
 * Control 主界面组件
 */
const ControlView: React.FC<ControlViewProps> = ({ isHidden, onSwitchToChat }) => {
	const { mode, setMode } = useExtensionState()
	const textAreaRef = useRef<HTMLTextAreaElement>(null)

	const [userPrompt, setUserPrompt] = useState("")
	const [discoveryRule, setDiscoveryRule] = useState("")
	const [processingRule, setProcessingRule] = useState("")
	const [progress, setProgress] = useState<ControlTaskProgress | null>(null)
	const [subTasks, setSubTasks] = useState<SubTask[]>([])
	const [isStarted, setIsStarted] = useState(false)
	const [useRuleMode, setUseRuleMode] = useState(false) // 是否使用规则模式
	const [selectedImages, setSelectedImages] = useState<string[]>([])

	// 处理来自扩展的消息
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			switch (message.type) {
				case "controlProgress":
					setProgress(message.progress)
					if (message.subTasks) {
						setSubTasks(message.subTasks)
					}
					// 检查任务是否完成或失败
					if (
						message.progress.status === ControlTaskStatus.COMPLETED ||
						message.progress.status === ControlTaskStatus.FAILED ||
						message.progress.status === ControlTaskStatus.CANCELLED
					) {
						// 任务结束，确保显示完整的子任务列表
						setIsStarted(true)
					}
					break
				case "controlStateResponse":
					// 收到完整的任务状态
					if (message.task) {
						const task = message.task
						setUserPrompt(task.userPrompt || "")
						setSubTasks(task.subTasks || [])
						setIsStarted(true)

						// 如果后端提供了 progress，直接使用它（这样可以保留 GENERATING_TEMPLATE 等状态）
						if (message.progress) {
							setProgress(message.progress)
						} else {
							// 否则根据子任务状态重建进度信息
							const completedCount = task.subTasks.filter(
								(t: any) => t.status === SubTaskStatus.COMPLETED,
							).length
							const failedCount = task.subTasks.filter(
								(t: any) => t.status === SubTaskStatus.FAILED,
							).length
							const cancelledCount = task.subTasks.filter(
								(t: any) => t.status === SubTaskStatus.CANCELLED,
							).length
							const runningTask = task.subTasks.find((t: any) => t.status === SubTaskStatus.RUNNING)
							const hasPendingEnabledTasks = task.subTasks.some(
								(t: any) => t.status === SubTaskStatus.PENDING && t.enabled !== false,
							)

							// 判断任务整体状态
							let taskStatus = ControlTaskStatus.PROCESSING
							if (runningTask) {
								taskStatus = ControlTaskStatus.PROCESSING
							} else if (hasPendingEnabledTasks) {
								// 有待处理的启用任务，状态应该是PROCESSING
								taskStatus = ControlTaskStatus.PROCESSING
							} else if (completedCount + failedCount + cancelledCount === task.subTasks.length) {
								// 所有任务都已完成/失败/取消
								// 如果有待处理任务但都被取消了，状态是CANCELLED
								// 否则是COMPLETED
								const allNonCompletedAreCancelled = task.subTasks.every(
									(t: any) =>
										t.status === SubTaskStatus.COMPLETED || t.status === SubTaskStatus.CANCELLED,
								)
								if (cancelledCount > 0 && allNonCompletedAreCancelled && completedCount === 0) {
									// 没有完成任何任务，所有都是取消的，说明是整体终止
									taskStatus = ControlTaskStatus.CANCELLED
								} else {
									taskStatus = ControlTaskStatus.COMPLETED
								}
							}

							setProgress({
								status: taskStatus,
								currentFileIndex: completedCount + failedCount + cancelledCount,
								totalFiles: task.subTasks.length,
								completedCount,
								failedCount,
								message:
									taskStatus === ControlTaskStatus.CANCELLED
										? "任务已终止"
										: taskStatus === ControlTaskStatus.COMPLETED
											? "所有文件处理完成"
											: hasPendingEnabledTasks
												? "等待处理下一个任务"
												: `正在处理: ${runningTask?.filePath || ""}`,
							})
						}
					}
					break
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	// 组件显示时，请求当前任务状态
	useEffect(() => {
		if (!isHidden) {
			// 请求后端的当前任务状态
			vscode.postMessage({
				type: "requestControlState",
			})
		}
	}, [isHidden])

	// 开始 Control 任务
	const handleStartTask = useCallback(() => {
		if (useRuleMode) {
			// 规则模式：需要两个规则都输入
			if (!discoveryRule.trim() || !processingRule.trim()) {
				vscode.postMessage({
					type: "showWarning",
					text: "请输入文件发现规则和文件处理规则",
				})
				return
			}

			setIsStarted(true)
			vscode.postMessage({
				type: "startControlTask",
				text: `#${discoveryRule.trim()}\n$${processingRule.trim()}`,
			})
		} else {
			// 传统模式：使用单一提示词
			if (!userPrompt.trim()) {
				vscode.postMessage({
					type: "showWarning",
					text: "请输入提示词",
				})
				return
			}

			setIsStarted(true)
			vscode.postMessage({
				type: "startControlTask",
				text: userPrompt,
			})
		}
	}, [userPrompt, discoveryRule, processingRule, useRuleMode])

	// 继续下一个任务
	const handleContinueNext = useCallback(() => {
		vscode.postMessage({
			type: "continueNextControlTask",
		})
	}, [])

	// 切换任务启用状态
	const handleToggleTaskEnabled = useCallback((taskId: string) => {
		vscode.postMessage({
			type: "toggleControlTaskEnabled",
			taskId,
		})
	}, [])

	// 取消任务
	const handleCancelTask = useCallback(() => {
		vscode.postMessage({
			type: "cancelControlTask",
		})
	}, [])

	// 重新开始
	const handleReset = useCallback(() => {
		setUserPrompt("")
		setDiscoveryRule("")
		setProcessingRule("")
		setProgress(null)
		setSubTasks([])
		setIsStarted(false)
		vscode.postMessage({
			type: "resetControl",
		})
	}, [])

	// 点击子任务，跳转到对应的对话
	const handleTaskClick = useCallback((task: SubTask) => {
		if (task.taskId) {
			vscode.postMessage({
				type: "showTaskWithId",
				text: task.taskId,
			})
		}
	}, [])

	// 返回到对话界面
	const handleBackToChat = useCallback(() => {
		if (onSwitchToChat) {
			onSwitchToChat()
		} else {
			vscode.postMessage({
				type: "switchTab",
				tab: "chat",
			})
		}
	}, [onSwitchToChat])

	// 渲染状态标签
	const renderStatusBadge = (status: SubTaskStatus) => {
		const statusConfig = {
			[SubTaskStatus.PENDING]: { label: "等待中", color: "text-gray-500", bgColor: "bg-gray-100" },
			[SubTaskStatus.RUNNING]: { label: "处理中", color: "text-blue-600", bgColor: "bg-blue-100" },
			[SubTaskStatus.COMPLETED]: { label: "已完成", color: "text-green-600", bgColor: "bg-green-100" },
			[SubTaskStatus.FAILED]: { label: "失败", color: "text-red-600", bgColor: "bg-red-100" },
			[SubTaskStatus.CANCELLED]: { label: "已取消", color: "text-orange-600", bgColor: "bg-orange-100" },
		}

		const config = statusConfig[status]
		return (
			<span
				className={cn(
					"px-2 py-1 rounded text-xs font-medium",
					config.color,
					config.bgColor,
					"dark:bg-opacity-20",
				)}>
				{config.label}
			</span>
		)
	}

	// 计算进度百分比
	const progressPercentage =
		progress && progress.totalFiles > 0
			? Math.round(((progress.completedCount + progress.failedCount) / progress.totalFiles) * 100)
			: 0

	// 是否正在处理
	const isProcessing =
		progress !== null &&
		(progress.status === ControlTaskStatus.PARSING ||
			progress.status === ControlTaskStatus.GENERATING_TEMPLATE ||
			progress.status === ControlTaskStatus.PROCESSING)

	return (
		<div className={cn("h-full flex flex-col overflow-hidden", isHidden && "hidden")}>
			{/* 头部标题栏 */}
			<div className="px-5 py-3 border-b border-vscode-editorGroup-border flex-shrink-0">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<h2 className="text-base font-semibold">Control 批量处理</h2>
						{!isStarted && (
							<div className="flex items-center gap-2">
								<button
									className={cn(
										"px-2 py-0.5 rounded text-xs transition-colors",
										!useRuleMode
											? "bg-vscode-button-background text-vscode-button-foreground"
											: "bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border hover:bg-vscode-list-hoverBackground",
									)}
									onClick={() => setUseRuleMode(false)}>
									传统模式
								</button>
								<button
									className={cn(
										"px-2 py-0.5 rounded text-xs transition-colors",
										useRuleMode
											? "bg-vscode-button-background text-vscode-button-foreground"
											: "bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border hover:bg-vscode-list-hoverBackground",
									)}
									onClick={() => setUseRuleMode(true)}>
									规则模式
								</button>
							</div>
						)}
					</div>
					<button
						onClick={handleBackToChat}
						className="text-xs text-vscode-textLink-foreground hover:underline flex items-center gap-1">
						<i className="codicon codicon-arrow-left"></i>
						返回对话
					</button>
				</div>
			</div>

			{/* 进度信息区域 */}
			{progress && (
				<div className="px-5 py-3 flex-shrink-0 border-b border-vscode-editorGroup-border bg-vscode-editor-background">
					{/* 状态信息 */}
					<div className="mb-2">
						<div className="flex items-center justify-between mb-2">
							<div className="text-sm font-medium">{progress.message || "处理中..."}</div>
							<div className="text-xs text-vscode-descriptionForeground">
								{progress.completedCount + progress.failedCount} / {progress.totalFiles}
							</div>
						</div>

						{/* 进度条 */}
						<div className="w-full h-2 bg-vscode-progressBar-background rounded-full overflow-hidden">
							<div
								className="h-full bg-vscode-progressBar-foreground transition-all duration-300"
								style={{ width: `${progressPercentage}%` }}
							/>
						</div>
					</div>

					{/* 统计信息 */}
					<div className="flex items-center gap-4 text-xs mb-3">
						<div className="flex items-center gap-1">
							<span className="text-green-600">✓</span>
							<span>完成: {progress.completedCount}</span>
						</div>
						<div className="flex items-center gap-1">
							<span className="text-red-600">✗</span>
							<span>失败: {progress.failedCount}</span>
						</div>
						<div className="flex items-center gap-1">
							<span className="text-gray-500">○</span>
							<span>
								待处理: {subTasks.filter((t) => t.enabled && t.status === SubTaskStatus.PENDING).length}
							</span>
						</div>
					</div>

					{/* 操作按钮 */}
					<div className="flex gap-2">
						{/* 任务已终止，只显示结束任务按钮 */}
						{progress && progress.status === ControlTaskStatus.CANCELLED && (
							<VSCodeButton onClick={handleReset}>结束任务</VSCodeButton>
						)}

						{/* 任务完成后显示结束任务按钮 */}
						{progress && progress.status === ControlTaskStatus.COMPLETED && (
							<VSCodeButton onClick={handleReset}>结束任务</VSCodeButton>
						)}

						{/* 任务失败后显示结束任务按钮 */}
						{progress && progress.status === ControlTaskStatus.FAILED && (
							<VSCodeButton onClick={handleReset}>结束任务</VSCodeButton>
						)}

						{/* 正在生成指令模板 */}
						{progress && progress.status === ControlTaskStatus.GENERATING_TEMPLATE && (
							<VSCodeButton onClick={handleCancelTask} appearance="secondary">
								终止任务
							</VSCodeButton>
						)}

						{/* 任务进行中的按钮 */}
						{progress && progress.status === ControlTaskStatus.PROCESSING && (
							<>
								{/* 继续下一个任务按钮（有待处理任务时显示） */}
								{subTasks.some((t) => t.enabled && t.status === SubTaskStatus.PENDING) && (
									<VSCodeButton onClick={handleContinueNext}>开始下一个任务</VSCodeButton>
								)}

								{/* 终止任务按钮 */}
								<VSCodeButton onClick={handleCancelTask} appearance="secondary">
									终止任务
								</VSCodeButton>
							</>
						)}
					</div>
				</div>
			)}

			{/* 中间内容区域 - 子任务列表或欢迎页 */}
			<div className="flex-1 overflow-y-auto">
				{subTasks.length > 0 ? (
					<div className="px-5 py-4">
						<h3 className="text-sm font-semibold mb-3">子任务列表</h3>
						<div className="space-y-2">
							{subTasks.map((task) => (
								<div
									key={task.id}
									className={cn(
										"p-3 rounded-lg border transition-colors",
										task.status === SubTaskStatus.RUNNING
											? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
											: task.status === SubTaskStatus.CANCELLED
												? "border-vscode-editorGroup-border bg-gray-100 dark:bg-gray-800/50 opacity-60"
												: "border-vscode-editorGroup-border bg-vscode-editor-background",
									)}>
									<div className="flex items-center justify-between mb-1">
										<div className="flex items-center gap-2 flex-1 min-w-0">
											{/* 启用/禁用复选框（仅在任务进行中且任务为PENDING或CANCELLED时显示） */}
											{progress &&
												progress.status === ControlTaskStatus.PROCESSING &&
												(task.status === SubTaskStatus.PENDING ||
													task.status === SubTaskStatus.CANCELLED) &&
												task.filePath !== "[文件发现任务]" && (
													<button
														className={cn(
															"flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition-all cursor-pointer",
															task.status === SubTaskStatus.PENDING && task.enabled
																? "bg-green-500 border-green-500"
																: "bg-transparent border-gray-400 dark:border-gray-500",
														)}
														onClick={(e) => {
															e.stopPropagation()
															handleToggleTaskEnabled(task.id)
														}}
														title={
															task.status === SubTaskStatus.CANCELLED
																? "点击重新启用"
																: task.enabled
																	? "点击取消"
																	: "点击启用"
														}>
														{task.status === SubTaskStatus.PENDING && task.enabled && (
															<svg
																className="w-3 h-3 text-white"
																fill="none"
																stroke="currentColor"
																viewBox="0 0 24 24">
																<path
																	strokeLinecap="round"
																	strokeLinejoin="round"
																	strokeWidth={3}
																	d="M5 13l4 4L19 7"
																/>
															</svg>
														)}
													</button>
												)}

											<div
												className={cn(
													"flex-1 text-sm font-mono truncate cursor-pointer",
													task.status === SubTaskStatus.CANCELLED &&
														"line-through opacity-60",
												)}
												title={task.filePath}
												onClick={() => task.taskId && handleTaskClick(task)}>
												{task.filePath}
											</div>

											{task.taskId && (
												<i
													className="codicon codicon-link-external text-xs text-vscode-descriptionForeground cursor-pointer"
													title="点击查看对话"
													onClick={() => handleTaskClick(task)}></i>
											)}
										</div>
										{renderStatusBadge(task.status)}
									</div>

									{/* 显示错误信息（文件发现任务不显示） */}
									{task.error && task.filePath !== "[文件发现任务]" && (
										<div className="mt-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 p-2 rounded">
											{task.error}
										</div>
									)}

									{/* 显示执行时间 */}
									{task.startTime && task.endTime && (
										<div className="mt-1 text-xs text-vscode-descriptionForeground">
											耗时: {((task.endTime - task.startTime) / 1000).toFixed(2)}s
										</div>
									)}
								</div>
							))}
						</div>
					</div>
				) : !isStarted && !progress ? (
					// 欢迎页面
					<div className="flex items-center justify-center h-full px-5 py-10">
						<div className="text-center text-vscode-descriptionForeground max-w-md">
							<div className="text-4xl mb-4">🔄</div>
							<h3 className="text-base font-semibold mb-2">批量处理文件</h3>
							<p className="text-sm mb-4">支持两种模式：</p>
							<div className="text-left text-xs space-y-2 bg-vscode-sideBar-background p-3 rounded border border-vscode-editorGroup-border">
								<div>
									<strong>传统模式：</strong>
									<br />
									使用单一提示词，支持 <code>@/path</code> 指定目录
								</div>
								<div>
									<strong>规则模式：</strong>
									<br />
									<span className="text-blue-500">#</span> 文件发现规则 - 确定要处理的文件
									<br />
									<span className="text-green-500">$</span> 文件处理规则 - 描述如何处理每个文件
								</div>
							</div>
							<p className="text-xs mt-3 text-vscode-descriptionForeground">
								💡 支持通过 .coignore 文件过滤不需要处理的文件
							</p>
						</div>
					</div>
				) : null}
			</div>

			{/* Portal容器 - 用于Popover等弹出组件 */}
			<div id="roo-portal" />

			{/* 底部输入区域 */}
			{!isStarted && (
				<div className="flex-shrink-0 border-t border-vscode-editorGroup-border">
					{!useRuleMode ? (
						// 传统模式 - 使用ChatTextArea（ChatTextArea自带padding，无需额外包装）
						<ChatTextArea
							ref={textAreaRef}
							inputValue={userPrompt}
							setInputValue={setUserPrompt}
							sendingDisabled={isProcessing}
							selectApiConfigDisabled={true}
							placeholderText="输入您的需求，将对指定目录下的所有文件进行处理。例如：&#10;@/src 添加详细注释&#10;如果不指定目录，将处理整个项目"
							selectedImages={selectedImages}
							setSelectedImages={setSelectedImages}
							onSend={handleStartTask}
							onSelectImages={() => {}}
							shouldDisableImages={true}
							mode={mode}
							setMode={setMode}
							modeShortcutText=""
							hoverPreviewMap={new Map()}
						/>
					) : (
						// 规则模式 - 显示两个输入框
						<div className="px-5 py-4 space-y-3">
							<div>
								<label className="block text-xs font-medium mb-1 flex items-center gap-1">
									<span className="text-blue-500">#</span>
									文件发现规则
								</label>
								<textarea
									className="w-full min-h-[80px] p-2 rounded border border-vscode-input-border bg-vscode-input-background text-vscode-input-foreground resize-y font-mono text-xs"
									placeholder="描述要处理哪些文件，例如：找出所有 src 目录下的 TypeScript 文件"
									value={discoveryRule}
									onChange={(e) => setDiscoveryRule(e.target.value)}
									disabled={isProcessing}
								/>
							</div>
							<div>
								<label className="block text-xs font-medium mb-1 flex items-center gap-1">
									<span className="text-green-500">$</span>
									文件处理规则
								</label>
								<textarea
									className="w-full min-h-[80px] p-2 rounded border border-vscode-input-border bg-vscode-input-background text-vscode-input-foreground resize-y font-mono text-xs"
									placeholder="描述如何处理每个文件，例如：为所有导出的函数添加 JSDoc 注释"
									value={processingRule}
									onChange={(e) => setProcessingRule(e.target.value)}
									disabled={isProcessing}
								/>
							</div>
							<div className="flex items-center justify-between">
								<div className="text-xs text-vscode-descriptionForeground">
									💡 规则模式使用两步处理：先发现文件，再逐个处理
								</div>
								<VSCodeButton
									onClick={handleStartTask}
									disabled={!discoveryRule.trim() || !processingRule.trim()}>
									开始处理
								</VSCodeButton>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	)
}

export default ControlView
