SELECT Sum([GST_Total]) AS [GST TOTAL]
FROM Transactions
WHERE (((Transactions.Date) Between #4/1/1999# And #9/30/1999#));
