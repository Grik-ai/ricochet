package agent

func (c *Controller) autoApprovalBudgetAllows(session *Session) bool {
	if c == nil || c.config == nil || c.config.AutoApproval == nil {
		return true
	}
	settings := c.config.AutoApproval
	if settings.MaxRequests <= 0 && settings.MaxCostUSD <= 0 {
		return true
	}

	c.autoApprovalMu.Lock()
	defer c.autoApprovalMu.Unlock()

	if settings.MaxRequests > 0 && c.autoApprovalRequests >= settings.MaxRequests {
		return false
	}
	if settings.MaxCostUSD > 0 && session != nil {
		cost := c.GetUsageSnapshot(session.ID).EstimatedCostUSD
		if c.autoApprovalCostBase == 0 {
			c.autoApprovalCostBase = cost
		}
		if cost-c.autoApprovalCostBase >= settings.MaxCostUSD {
			return false
		}
	}
	return true
}

func (c *Controller) recordAutoApproval(session *Session) {
	if c == nil || c.config == nil || c.config.AutoApproval == nil {
		return
	}
	settings := c.config.AutoApproval
	if settings.MaxRequests <= 0 && settings.MaxCostUSD <= 0 {
		return
	}

	c.autoApprovalMu.Lock()
	defer c.autoApprovalMu.Unlock()
	c.autoApprovalRequests++
	if settings.MaxCostUSD > 0 && c.autoApprovalCostBase == 0 && session != nil {
		c.autoApprovalCostBase = c.GetUsageSnapshot(session.ID).EstimatedCostUSD
	}
}

func (c *Controller) resetAutoApprovalBudget(session *Session) {
	c.autoApprovalMu.Lock()
	defer c.autoApprovalMu.Unlock()
	c.autoApprovalRequests = 0
	if session != nil {
		c.autoApprovalCostBase = c.GetUsageSnapshot(session.ID).EstimatedCostUSD
	} else {
		c.autoApprovalCostBase = 0
	}
}
