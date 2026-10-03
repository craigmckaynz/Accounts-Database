PARAMETERS Forms!InvoicesDialogBox!BeginningDate DateTime, Forms!InvoicesDialogBox!EndingDate DateTime;
SELECT invoice_date, invoice_number, company_name, job_name, sum(amount) AS [Sub Total], ([Sub Total]*0.125) AS GST, ([Sub Total]+[GST]) AS [Invoice Total]
FROM invoices, invoices_detail
WHERE invoice_date Between Forms!InvoicesDialogBox!BeginningDate And Forms!InvoicesDialogBox!EndingDate And invoices.invoice_id=invoices_detail.invoice_id
GROUP BY invoice_date, invoice_number, company_name, job_name;
